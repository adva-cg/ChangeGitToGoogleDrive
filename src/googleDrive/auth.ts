import * as vscode from 'vscode';
import { google } from 'googleapis';
import { promises as fs } from 'fs';
import * as url from 'url';
import * as http from 'http';
import { GOOGLE_DRIVE_CREDENTIALS_KEY, GOOGLE_DRIVE_TOKENS_KEY } from '../constants';

export async function setupGoogleCredentials(context: vscode.ExtensionContext) {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select client_secret.json',
        filters: { 'JSON files': ['json'] }
    });

    if (fileUri && fileUri[0]) {
        try {
            const fileContent = await fs.readFile(fileUri[0].fsPath, 'utf8');
            const credentials = JSON.parse(fileContent);
            if (credentials.installed || credentials.web) {
                await context.secrets.store(GOOGLE_DRIVE_CREDENTIALS_KEY, fileContent);
                vscode.window.showInformationMessage('Google credentials stored successfully.');
            } else {
                throw new Error('Invalid credentials file format.');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error processing credentials file: ${error.message}`);
        }
    }
}

export async function authenticateWithGoogle(context: vscode.ExtensionContext) {
    const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
    if (!credentialsStr) {
        vscode.window.showErrorMessage('Set up Google Credentials first.');
        return;
    }

    const credentials = JSON.parse(credentialsStr);
    const credsType = credentials.web ? 'web' : 'installed';
    const { client_id, client_secret, redirect_uris } = credentials[credsType];
    const redirect_uri = redirect_uris[0];
    const port = new url.URL(redirect_uri).port;

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

    const server = http.createServer(async (req, res) => {
        try {
            const code = new url.URL(req.url || '', `http://localhost:${port}`).searchParams.get('code');
            res.end('Authentication successful! You can close this tab.');
            server.close();
            if (!code) {
                vscode.window.showErrorMessage('Authentication failed: No code received.');
                return;
            }
            const { tokens } = await oauth2Client.getToken(code);

            if (!tokens.refresh_token) {
                console.warn('Refresh token was not returned by Google. This might happen if you did not provide full consent OR if you have already authenticated before.');
                vscode.window.showWarningMessage('Google не прислал "refresh_token". Это может привести к частым запросам авторизации. Если сессии будут слетать, попробуйте сначала "Выйти" в настройках аккаунта Google для приложения "VSCode Git Sync".');
            }

            await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(tokens));
            vscode.window.showInformationMessage('Successfully authenticated with Google.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Authentication failed: ${e.message}`);
            res.end('Authentication failed. Check logs.');
            server.close();
        }
    }).listen(port, () => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive.file'],
            prompt: 'consent'
        });
        console.log(`Attempting to open authentication URL: ${authUrl}`);
        vscode.window.showInformationMessage('Attempting to open the authentication URL in your browser...');
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
    });
}

export async function getAuthenticatedClient(context: vscode.ExtensionContext) {
    const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
    const tokensStr = await context.secrets.get(GOOGLE_DRIVE_TOKENS_KEY);

    if (!credentialsStr || !tokensStr) {
        vscode.window.showErrorMessage('Authentication required. Please run authentication command.');
        return null;
    }

    const credentials = JSON.parse(credentialsStr);
    const credsType = credentials.web ? 'web' : 'installed';
    const { client_id, client_secret, redirect_uris } = credentials[credsType];
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    oauth2Client.setCredentials(JSON.parse(tokensStr));

    const expiryDate = oauth2Client.credentials.expiry_date;
    const isTokenExpiring = expiryDate ? expiryDate <= Date.now() : false;

    if (isTokenExpiring) {
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            const oldTokens = JSON.parse(tokensStr || '{}');

            if (credentials && credentials.access_token) {
                if (oldTokens.refresh_token && !credentials.refresh_token) {
                    credentials.refresh_token = oldTokens.refresh_token;
                }
                await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(credentials));
                oauth2Client.setCredentials(credentials);
            } else {
                throw new Error("Google API returned an invalid response during refresh.");
            }
        } catch (error: any) {
            console.error("ChangeGitToGoogleDrive: Failed to refresh token", error);
            const detailedMessage = error.message.includes('invalid_grant') 
                ? "Сессия Google отозвана или недействительна (invalid_grant). Возможно, из-за смены пароля или входа с другого устройства."
                : error.message;
            vscode.window.showErrorMessage(
                `Failed to refresh token: ${detailedMessage}. Please run the 'Authenticate with Google' command again.`,
                { modal: true }
            );
            return null;
        }
    }
    return google.drive({ version: 'v3', auth: oauth2Client });
}
