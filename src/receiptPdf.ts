import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ReceiptLine {
  name: string;
  sku?: string | null;
  quantity_kg: number;
  quantity_sachets: number;
  quantity_cartons: number;
  unit_price: number;
}

export interface ReceiptData {
  orderId: number;
  orderDate: string;
  deliveryDate?: string | null;
  customerName: string;
  company?: string | null;
  phone?: string | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  lines: ReceiptLine[];
  total: number;
  sellerName?: string | null;
}

function money(n: number): string {
  return `Rs ${Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function qtyLabel(line: ReceiptLine): string {
  const parts: string[] = [];
  if (line.quantity_cartons > 0) parts.push(`${line.quantity_cartons} ctn`);
  if (line.quantity_sachets > 0) parts.push(`${line.quantity_sachets} sach`);
  if (line.quantity_kg > 0) parts.push(`${line.quantity_kg} kg`);
  return parts.join(" · ") || "—";
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export async function buildReceiptPdf(data: ReceiptData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 595]); // A5-ish receipt
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 36;
  let y = page.getHeight() - margin;

  const draw = (text: string, opts?: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> }) => {
    const size = opts?.size ?? 10;
    const f = opts?.bold ? bold : font;
    page.drawText(text, {
      x: margin,
      y,
      size,
      font: f,
      color: opts?.color ?? rgb(0.1, 0.1, 0.12),
      maxWidth: page.getWidth() - margin * 2,
    });
    y -= size + 4;
  };

  draw("ORDER RECEIPT", { size: 16, bold: true });
  draw(`Order #${data.orderId}`, { size: 12, bold: true });
  y -= 4;
  draw(`Order date: ${fmtDate(data.orderDate)}`);
  draw(`Delivery: ${fmtDate(data.deliveryDate || data.orderDate)}`);
  if (data.sellerName) draw(`Sold by: ${data.sellerName}`);
  y -= 6;
  draw("Client", { size: 9, bold: true, color: rgb(0.4, 0.4, 0.45) });
  draw(data.customerName, { bold: true });
  if (data.company && !data.customerName.toLowerCase().includes(data.company.toLowerCase())) {
    draw(data.company);
  }
  if (data.phone) draw(`Phone: ${data.phone}`);
  if (data.deliveryAddress) draw(`Address: ${data.deliveryAddress}`);
  if (data.notes) draw(`Notes: ${data.notes}`);
  y -= 8;

  // Divider
  page.drawLine({
    start: { x: margin, y: y + 6 },
    end: { x: page.getWidth() - margin, y: y + 6 },
    thickness: 0.8,
    color: rgb(0.75, 0.75, 0.78),
  });
  y -= 4;

  draw("Items", { size: 9, bold: true, color: rgb(0.4, 0.4, 0.45) });
  for (const line of data.lines) {
    const lineTotal = line.quantity_kg * line.unit_price;
    const title = line.sku ? `${line.name} (${line.sku})` : line.name;
    draw(title, { bold: true, size: 10 });
    draw(`${qtyLabel(line)}  ·  ${money(line.unit_price)}/kg  ·  ${money(lineTotal)}`, { size: 9 });
    y -= 2;
    if (y < 80) break;
  }

  y -= 4;
  page.drawLine({
    start: { x: margin, y: y + 6 },
    end: { x: page.getWidth() - margin, y: y + 6 },
    thickness: 0.8,
    color: rgb(0.75, 0.75, 0.78),
  });
  y -= 2;
  draw(`TOTAL  ${money(data.total)}`, { size: 13, bold: true });
  y -= 10;
  draw("Thank you for your order.", { size: 9, color: rgb(0.45, 0.45, 0.5) });

  return doc.save();
}

export function receiptWhatsAppText(data: ReceiptData): string {
  const itemLines = data.lines.map((line) => {
    const lineTotal = line.quantity_kg * line.unit_price;
    return `• ${line.name}: ${qtyLabel(line)} — ${money(lineTotal)}`;
  });
  const clientLabel =
    data.company && !data.customerName.toLowerCase().includes(data.company.toLowerCase())
      ? `${data.customerName} (${data.company})`
      : data.customerName;
  return [
    `*Order #${data.orderId}*`,
    `Client: ${clientLabel}`,
    `Order date: ${fmtDate(data.orderDate)}`,
    `Delivery: ${fmtDate(data.deliveryDate || data.orderDate)}`,
    "",
    ...itemLines,
    "",
    `*Total: ${money(data.total)}*`,
    data.deliveryAddress ? `Address: ${data.deliveryAddress}` : null,
    data.notes ? `Notes: ${data.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
