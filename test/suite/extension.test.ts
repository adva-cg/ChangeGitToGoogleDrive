import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

    test('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('VitalyAdadurov.changegittogoogledrive-extension'));
    });

    test('All commands should be registered', async () => {
        const extension = vscode.extensions.getExtension('VitalyAdadurov.changegittogoogledrive-extension');
        if (extension) {
            await extension.activate();
        }

        const allCommands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'changegittogoogledrive-extension.setupGoogleCredentials',
            'changegittogoogledrive-extension.authenticateWithGoogle',
            'changegittogoogledrive-extension.initialUpload',
            'changegittogoogledrive-extension.cloneFromGoogleDrive',
            'changegittogoogledrive-extension.sync',
            'changegittogoogledrive-extension.installGitHooks',
            'changegittogoogledrive-extension.manageSyncHash',
            'changegittogoogledrive-extension.configureAIHistorySync',
            'changegittogoogledrive-extension.syncAIHistory',
            'changegittogoogledrive-extension.toggleClipboardSync'
        ];

        for (const cmd of expectedCommands) {
            assert.ok(allCommands.includes(cmd), `Command ${cmd} is not registered`);
        }
    });
});
