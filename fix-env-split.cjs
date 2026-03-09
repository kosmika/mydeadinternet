// Fix the broken split('\n') in mdi-feeds.cjs
const fs = require('fs');
let code = fs.readFileSync('/var/www/mydeadinternet/mdi-feeds.cjs', 'utf8');

// Find and replace the broken env loading block
const brokenStart = code.indexOf("allEnv.split('");
if (brokenStart === -1) {
  console.log('Could not find allEnv.split - maybe already fixed?');
  process.exit(0);
}

const forEachIdx = code.indexOf('.forEach(line =>', brokenStart);
if (forEachIdx === -1) {
  console.log('Could not find .forEach after split');
  process.exit(1);
}

// Replace from allEnv.split(' ... ).forEach
const replacement = "allEnv.split(String.fromCharCode(10)).forEach(line =>";
code = code.slice(0, brokenStart) + replacement + code.slice(forEachIdx + '.forEach(line =>'.length);
fs.writeFileSync('/var/www/mydeadinternet/mdi-feeds.cjs', code);
console.log('Fixed split newline');
