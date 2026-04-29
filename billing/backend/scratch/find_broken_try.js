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
    
    // A very simple check for "try {" followed by nothing before the next "}" or "catch"
    // Actually, a better way is to see if we have "try {" and no corresponding "catch" or "finally"
    // within a reasonable scope.
    
    // But since the error is "Missing catch or finally clause", it means the parser saw "try { ... }" 
    // and then something else that wasn't catch/finally.
    
    // I'll search for "try {" and check if the next significant token is "catch" or "finally".
    // This is hard with regex. I'll just look for lines ending in "try {" and see the next lines.
    
    let lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('try {')) {
            // Scan ahead for catch or finally
            let found = false;
            let depth = 0;
            let started = false;
            for (let j = i; j < lines.length; j++) {
                let line = lines[j];
                if (line.includes('{')) {
                    depth += (line.match(/\{/g) || []).length;
                    started = true;
                }
                if (line.includes('}')) {
                    depth -= (line.match(/\}/g) || []).length;
                }
                
                if (started && depth === 0) {
                    // Check if next part is catch or finally
                    let remaining = line.substring(line.lastIndexOf('}') + 1).trim();
                    if (remaining.startsWith('catch') || remaining.startsWith('finally')) {
                        found = true;
                        break;
                    }
                    // Check next line
                    if (j + 1 < lines.length) {
                        let nextLine = lines[j+1].trim();
                        if (nextLine.startsWith('catch') || nextLine.startsWith('finally')) {
                            found = true;
                            break;
                        }
                    }
                    // If we got here and depth is 0, and no catch found, it might be broken
                    console.log(`Potential broken try in ${filePath} around line ${i+1}`);
                    break;
                }
            }
        }
    }
}

walk(rootDir, (filePath) => {
    findBrokenTry(filePath);
});
