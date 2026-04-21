import * as assert from 'assert';
import { 
    sanitizeBranchNameForDrive, 
    restoreBranchNameFromDrive, 
    escapeGdriveQueryParam 
} from '../../src/utils/common';

suite('Utility Logic Test Suite', () => {
    
    test('sanitizeBranchNameForDrive should replace slashes with underscores', () => {
        assert.strictEqual(sanitizeBranchNameForDrive('feature/login'), 'feature_login');
        assert.strictEqual(sanitizeBranchNameForDrive('fix/bug/123'), 'fix_bug_123');
        assert.strictEqual(sanitizeBranchNameForDrive('main'), 'main');
        assert.strictEqual(sanitizeBranchNameForDrive(''), '');
    });

    test('restoreBranchNameFromDrive should replace underscores with slashes', () => {
        assert.strictEqual(restoreBranchNameFromDrive('feature_login'), 'feature/login');
        assert.strictEqual(restoreBranchNameFromDrive('fix_bug_123'), 'fix/bug/123');
        assert.strictEqual(restoreBranchNameFromDrive('main'), 'main');
        assert.strictEqual(restoreBranchNameFromDrive(''), '');
    });

    test('escapeGdriveQueryParam should escape backslashes and single quotes', () => {
        assert.strictEqual(escapeGdriveQueryParam("my'file"), "my\\'file");
        assert.strictEqual(escapeGdriveQueryParam("folder\\name"), "folder/name");
        assert.strictEqual(escapeGdriveQueryParam("O'Reilly's Folder"), "O\\'Reilly\\'s Folder");
        assert.strictEqual(escapeGdriveQueryParam(""), "");
    });
});
