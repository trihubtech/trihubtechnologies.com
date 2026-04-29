const fs = require('fs');
const path = require('path');

const rootDir = 'd:/projects/CRM';
const extensions = ['.js', '.jsx', '.css', '.html', '.sql'];
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

function removeComments(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    
    
    
    content = content.replace(/\/\*[\s\S]*?\*\
    
    
    
    content = content.replace(/(^|[^\:])\/\/.*$/gm, (match, p1) => {
        return p1;
    });

    
    if (filePath.endsWith('.jsx')) {
        content = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    }

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Cleaned: ${filePath}`);
}

walk(rootDir, (filePath) => {
    try {
        removeComments(filePath);
    } catch (err) {
        console.error(`Error cleaning ${filePath}: ${err.message}`);
    }
});
