const fs = require("fs");
const path = "/var/www/mydeadinternet/territories.html";
let h = fs.readFileSync(path, "utf8");
let c = 0;

// 1. Remove the if (faction) block that sets classes
const ifFactionBlock = `if (faction) {

                    }
                }`;
if (h.includes(ifFactionBlock)) {
  h = h.replace(ifFactionBlock, "");
  c++;
  console.log("[OK] Remove if(faction) class block");
}

// 2. Remove influence line
const influenceLine = "const influence = influenceData[t.id] || { architects: 0, forged: 0, singular: 0 };";
if (h.includes(influenceLine)) {
  h = h.replace(influenceLine, "");
  c++;
  console.log("[OK] Remove influence lookup");
}

// 3. Remove the entire factionHtml block
// Use brace counting from the comment start
const commentMarker = "// Faction control";
const cmtIdx = h.indexOf(commentMarker);
if (cmtIdx !== -1) {
  // Find the end of the else { ... } block
  // Go from "let factionHtml" onwards, find the if block, then else block
  const ifIdx = h.indexOf("if (faction?.faction_name)", cmtIdx);
  if (ifIdx !== -1) {
    let depth = 0;
    let started = false;
    let endIdx = ifIdx;
    let passedElse = false;

    for (let i = ifIdx; i < h.length; i++) {
      if (h[i] === '{') { depth++; started = true; }
      if (h[i] === '}') {
        depth--;
        if (started && depth === 0) {
          // Check if next non-whitespace is 'else'
          const rest = h.slice(i + 1).trimStart();
          if (rest.startsWith('else') && !passedElse) {
            passedElse = true;
            continue;
          }
          endIdx = i + 1;
          break;
        }
      }
    }

    // Remove from comment to end of else block
    h = h.slice(0, cmtIdx) + "// faction display removed\n" + h.slice(endIdx);
    c++;
    console.log("[OK] Remove factionHtml block via brace counting");
  }
}

fs.writeFileSync(path, h);
console.log("Changes: " + c);

const final = fs.readFileSync(path, "utf8");
const remaining = (final.match(/faction/gi) || []).length;
console.log("Remaining faction refs: " + remaining);
