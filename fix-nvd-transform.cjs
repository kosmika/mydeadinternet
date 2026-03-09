/**
 * Add NVD CVE transform and fix npm transform
 * Run from /var/www/mydeadinternet/
 */
const fs = require('fs');
const file = '/var/www/mydeadinternet/mdi-feeds.cjs';
let code = fs.readFileSync(file, 'utf8');

// Replace the CISA transform with NVD transform
const oldCisa = /function transformCisaKev\(data, config\) \{[\s\S]*?\n\}/;
const newNvd = `function transformCisaKev(data, config) {
  // NVD 2.0 API format
  const vulns = (data.vulnerabilities || []).slice(0, 15);
  return vulns.map(function(v) {
    var cve = v.cve || {};
    var id = cve.id || 'Unknown';
    var desc = (cve.descriptions || []).find(function(d) { return d.lang === 'en'; });
    var descText = desc ? desc.value : 'No description';
    var metrics = cve.metrics || {};
    var cvss = null;
    if (metrics.cvssMetricV31 && metrics.cvssMetricV31[0]) {
      cvss = metrics.cvssMetricV31[0].cvssData;
    } else if (metrics.cvssMetricV30 && metrics.cvssMetricV30[0]) {
      cvss = metrics.cvssMetricV30[0].cvssData;
    }
    var severity = cvss ? cvss.baseSeverity : 'UNKNOWN';
    var score = cvss ? cvss.baseScore : '?';
    return {
      content: [
        '**CVE: ' + id + '** (Severity: ' + severity + ', Score: ' + score + ')',
        descText.slice(0, 400),
        'Published: ' + (cve.published || 'Unknown')
      ].join('\\n'),
      source_url: 'https://nvd.nist.gov/vuln/detail/' + id,
      metadata: { cve: id, severity: severity, score: score, published: cve.published }
    };
  });
}`;

if (oldCisa.test(code)) {
  code = code.replace(oldCisa, newNvd);
  console.log('Replaced CISA transform with NVD transform');
} else {
  console.log('WARNING: Could not find CISA transform to replace');
}

fs.writeFileSync(file, code);
console.log('Done');
