// Kleine PDF-schrijver zonder afhankelijkheden: A4-pagina's met tekst (Helvetica), lijnen, vlakken en eenvoudige staafdiagrammen.
// Genoeg voor het maandrapport; geen afbeeldingen of ingesloten fonts. Tekst in WinAnsi (cp1252), dus € en accenten werken.
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
function codeer(tekst) {
  const bytes = [];
  for (const ch of String(tekst)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0xa0 && c <= 0xff) bytes.push(c);
    else if (CP1252[ch] != null) bytes.push(CP1252[ch]);
    else bytes.push(0x3f); // ?
  }
  return Buffer.from(bytes);
}
function escapeer(buf) {
  let s = '';
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return s;
}
// Globale breedtes van Helvetica (per 1000) voor de meest gebruikte tekens; onbekende tekens tellen als 556.
const BREEDTE = { ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, 0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584, '€': 556 };
function breedte(tekst, grootte) {
  let w = 0;
  for (const ch of String(tekst)) w += BREEDTE[ch] != null ? BREEDTE[ch] : 556;
  return (w / 1000) * grootte;
}

class Document {
  constructor({ titel = 'Rapport', auteur = 'boekpouwvervoer' } = {}) {
    this.titel = titel;
    this.auteur = auteur;
    this.paginas = [];
    this.breedtePagina = 595.28;
    this.hoogtePagina = 841.89;
    this.marge = 48;
    this.nieuwePagina();
  }
  nieuwePagina() {
    this.huidig = { inhoud: [] };
    this.paginas.push(this.huidig);
    this.y = this.hoogtePagina - this.marge;
    return this;
  }
  get pagina() {
    return this.paginas.length;
  }
  ruimte(hoogte) {
    if (this.y - hoogte < this.marge) this.nieuwePagina();
  }
  kleur(r, g, b, vulling = true) {
    this.huidig.inhoud.push(`${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} ${vulling ? 'rg' : 'RG'}`);
    return this;
  }
  tekst(t, { x = this.marge, grootte = 10, vet = false, kleur = [29, 35, 51], y = null, uitlijning = 'links', breedteVak = null } = {}) {
    const lijn = y == null ? this.y - grootte : y;
    let xx = x;
    const w = breedte(t, grootte);
    if (uitlijning === 'rechts') xx = x + (breedteVak || 0) - w;
    else if (uitlijning === 'midden') xx = x + ((breedteVak || 0) - w) / 2;
    this.kleur(...kleur);
    this.huidig.inhoud.push(`BT /${vet ? 'F2' : 'F1'} ${grootte} Tf ${xx.toFixed(2)} ${lijn.toFixed(2)} Td (${escapeer(codeer(t))}) Tj ET`);
    if (y == null) this.y = lijn - grootte * 0.45;
    return this;
  }
  regel(t, opties = {}) {
    const grootte = opties.grootte || 10;
    this.ruimte(grootte * 1.6);
    return this.tekst(t, opties);
  }
  kop(t, grootte = 14) {
    this.ruimte(grootte * 2.2);
    this.y -= grootte * 0.6;
    this.tekst(t, { grootte, vet: true, kleur: [38, 54, 128] });
    this.y -= 4;
    return this;
  }
  witruimte(h = 8) {
    this.y -= h;
    return this;
  }
  vlak(x, y, w, h, kleur = [243, 245, 250]) {
    this.kleur(...kleur);
    this.huidig.inhoud.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    return this;
  }
  lijn(x1, y1, x2, y2, kleur = [217, 221, 232], dikte = 0.6) {
    this.kleur(...kleur, false);
    this.huidig.inhoud.push(`${dikte} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    return this;
  }
  // Tabel: kolommen [{ label, breedte, uitlijning }], rijen als arrays van strings.
  tabel(kolommen, rijen, { grootte = 9 } = {}) {
    const hoogteRij = grootte * 1.9;
    const x0 = this.marge;
    const teken = (cellen, vet, achtergrond) => {
      this.ruimte(hoogteRij + 2);
      const top = this.y;
      if (achtergrond) this.vlak(x0, top - hoogteRij, kolommen.reduce((s, k) => s + k.breedte, 0), hoogteRij, achtergrond);
      let x = x0;
      cellen.forEach((c, i) => {
        const k = kolommen[i];
        this.tekst(String(c == null ? '' : c), { x: x + 4, y: top - hoogteRij + grootte * 0.55, grootte, vet, uitlijning: k.uitlijning || 'links', breedteVak: k.breedte - 8, kleur: vet && achtergrond ? [255, 255, 255] : [29, 35, 51] });
        x += k.breedte;
      });
      this.y = top - hoogteRij;
    };
    teken(kolommen.map((k) => k.label), true, [38, 54, 128]);
    rijen.forEach((r, i) => teken(r, false, i % 2 ? [243, 245, 250] : null));
    this.y -= 6;
    return this;
  }
  // Staafdiagram: reeks [{ label, waarden: [a, b] }], twee kleuren; labels onder de assen om de n.
  staven(reeks, { hoogte = 120, kleuren = [[38, 54, 128], [161, 42, 30]], legenda = [], elkeLabel = 4, formaat = (v) => String(v) } = {}) {
    this.ruimte(hoogte + 40);
    const x0 = this.marge;
    const w = this.breedtePagina - 2 * this.marge;
    const top = this.y - 10;
    const basis = top - hoogte;
    const max = Math.max(1, ...reeks.flatMap((r) => r.waarden));
    const n = reeks.length;
    const stap = w / n;
    this.lijn(x0, basis, x0 + w, basis, [120, 128, 150], 0.8);
    this.tekst(formaat(max), { x: x0, y: top - 6, grootte: 7, kleur: [91, 100, 120] });
    reeks.forEach((r, i) => {
      const bx = x0 + i * stap;
      r.waarden.forEach((v, j) => {
        const h = (v / max) * (hoogte - 12);
        const bw = Math.max(1, (stap - 4) / r.waarden.length);
        this.vlak(bx + 2 + j * bw, basis, bw - 1, h, kleuren[j] || kleuren[0]);
      });
      if (i % elkeLabel === 0 || i === n - 1) this.tekst(r.label, { x: bx, y: basis - 10, grootte: 6.5, kleur: [91, 100, 120] });
    });
    let lx = x0;
    legenda.forEach((l, j) => {
      this.vlak(lx, basis - 24, 8, 8, kleuren[j]);
      this.tekst(l, { x: lx + 12, y: basis - 23, grootte: 8, kleur: [91, 100, 120] });
      lx += breedte(l, 8) + 28;
    });
    this.y = basis - 34;
    return this;
  }
  buffer() {
    const objecten = [];
    const voeg = (s) => objecten.push(s) && objecten.length;
    const fontRegular = voeg('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = voeg('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const paginaIds = [];
    const paginasId = objecten.length + this.paginas.length * 2 + 1;
    for (const p of this.paginas) {
      const stroom = Buffer.from(p.inhoud.join('\n'), 'latin1');
      const inhoudId = voeg(Buffer.concat([Buffer.from(`<< /Length ${stroom.length} >>\nstream\n`, 'latin1'), stroom, Buffer.from('\nendstream', 'latin1')]));
      const paginaId = voeg(`<< /Type /Page /Parent ${paginasId} 0 R /MediaBox [0 0 ${this.breedtePagina} ${this.hoogtePagina}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${inhoudId} 0 R >>`);
      paginaIds.push(paginaId);
    }
    const echtePaginasId = voeg(`<< /Type /Pages /Kids [${paginaIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginaIds.length} >>`);
    if (echtePaginasId !== paginasId) throw new Error('interne fout in de PDF-opbouw');
    const infoId = voeg(`<< /Title (${escapeer(codeer(this.titel))}) /Author (${escapeer(codeer(this.auteur))}) /Producer (boekpouwvervoer) >>`);
    const catalogId = voeg(`<< /Type /Catalog /Pages ${paginasId} 0 R >>`);
    const delen = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let positie = delen[0].length;
    objecten.forEach((o, i) => {
      offsets.push(positie);
      const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
      delen.push(buf);
      positie += buf.length;
    });
    const xref = [`xref\n0 ${objecten.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    delen.push(Buffer.from(`${xref}trailer\n<< /Size ${objecten.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${positie}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(delen);
  }
}

module.exports = { Document, breedte, codeer };
