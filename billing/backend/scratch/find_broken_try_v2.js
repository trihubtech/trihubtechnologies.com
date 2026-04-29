const fs = require('fs');
const path = require('path');

const rootDir = 'd:/projects/CRM';
const extensions = ['.js', '.jsx'];
const excludeDirs = ['node_modules', '.git', 'build', 'dist', 'uploads', '.gemini'];

function walk(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        if (isDirectory) {
            if (!excludeDirs.includes(f)) {
                walk(dirPath, callback);
            }
        } else {
            if (extensions.includes(path.extname(f))) {
                callback(dirPath);
            }
        }
    });
}

function findBrokenTry(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Use a regex to find all "try {"
    // Then find the matching closing brace.
    
    let tryIndices = [];
    let regex = /try\s*\{/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        tryIndices.push(match.index);
    }
    
    for (let startIdx of tryIndices) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx + 3; i < content.length; i++) {
            if (content[i] === '{') depth++;
            if (content[i] === '}') {
                depth--;
                if (depth === -1) {
                    endIdx = i;
                    break;
                }
            }
        }
        
        if (endIdx !== -1) {
            let following = content.substring(endIdx + 1).trim();
            if (!following.startsWith('catch') && !following.startsWith('finally')) {
                // Find line number
                let lineNo = content.substring(0, startIdx).split('\n').length;
                console.log(`BROKEN TRY in ${filePath} at line ${lineNo}`);
            }
        }
    }
}

walk(rootDir, (filePath) => {
    findBrokenTry(filePath);
});
