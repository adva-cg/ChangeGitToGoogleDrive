const path = require('path');
const localPath = 'C:\\temp\\conv';
const fileName = '.system_generated/messages/foo.json';
const destPath = path.join(localPath, fileName);
console.log('destPath:', destPath);
console.log('dirname:', path.dirname(destPath));
