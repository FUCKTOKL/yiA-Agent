import { crc32, deflateRawSync } from "node:zlib";

/** 可重现的极小测试电子书，不在仓库分发用户的整本书。 */
export function zipFixture(entries: Record<string, string>, options: { compressed?: boolean; declaredSize?: number } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const path = Buffer.from(name), data = Buffer.from(text), packed = options.compressed ? deflateRawSync(data) : data;
    const size = options.declaredSize ?? data.length, checksum = crc32(data), method = options.compressed ? 8 : 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(checksum, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(size, 22); head.writeUInt16LE(path.length, 26);
    local.push(head, path, packed);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt16LE(0x800, 8); item.writeUInt16LE(method, 10);
    item.writeUInt32LE(checksum, 16); item.writeUInt32LE(packed.length, 20); item.writeUInt32LE(size, 24); item.writeUInt16LE(path.length, 28); item.writeUInt32LE(offset, 42);
    central.push(item, path); offset += head.length + path.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function epubFixture(href = "two.xhtml"): Buffer {
  return zipFixture({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>中文 EPUB 测试书</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>`,
    "OPS/one.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title><script>private_script_marker</script></head><body><h1>第一章</h1><p>刻意练习与目标设定。A &amp; B&nbsp;practice.</p><script>another_script_marker</script></body></html>',
    "OPS/two.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p>这章在阅读顺序里排在前面。热爱学习。</p></body></html>',
  });
}
export function pdfFixture(text = "Practice makes progress. Build a daily learning routine.", encrypted = false): Buffer {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = text ? `BT /F1 12 Tf 20 180 Td (${escaped}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Title (Fixture PDF) /Author (Test Author) >>",
  ];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R${encrypted ? ` /Encrypt 7 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
