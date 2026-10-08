import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vaultPath = '/Users/spencer/Vaults/bnotes/.obsidian/plugins/booksidian-plugin';
// Preserve data.json: Obsidian writes the user's plugin settings there.
const files = ['main.js', 'manifest.json', 'styles.css'];

// Ensure vault plugin directory exists
if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
    console.log(`Created directory: ${vaultPath}`);
}

files.forEach(file => {
    const src = path.join(__dirname, file);
    const dst = path.join(vaultPath, file);

    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log(`✓ Copied ${file}`);
    } else {
        console.warn(`⚠ Warning: ${file} not found`);
    }
});

console.log('Done copying files to vault.');

// Reload the plugin in the local Obsidian vault so changes take effect
// without a manual disable/enable cycle.
try {
    const res = await fetch('http://127.0.0.1:37420/');
    if (res.ok) {
        console.log('✓ Triggered Obsidian plugin reload (local reload server)');
    } else {
        console.log(`⚠ Reload server responded ${res.status}; reload the plugin manually.`);
    }
} catch {
    console.log('⚠ Reload server not running; reload the plugin manually (disable/enable in Obsidian).');
}
