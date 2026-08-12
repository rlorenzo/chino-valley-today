// Shared PDF text extraction (pdf-parse v2 class API).
import { PDFParse } from 'pdf-parse';

export interface PdfText {
  text: string;
  numPages: number;
}

export async function extractPdfText(buf: Buffer): Promise<PdfText> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return { text: res.text, numPages: res.total ?? 0 };
  } finally {
    await parser.destroy();
  }
}
