import Busboy from "busboy";
import type { Request } from "express";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type MultipartFile = {
  buffer: Buffer;
  mime: string;
  filename: string;
};

export type MultipartResult = {
  fields: Record<string, string>;
  file: MultipartFile | null;
};

export function parseMultipart(req: Request): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      resolve({ fields: {}, file: null });
      return;
    }

    const fields: Record<string, string> = {};
    let file: MultipartFile | null = null;
    let rejected = false;

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: MAX_IMAGE_BYTES },
    });

    busboy.on("file", (_name, stream, info) => {
      const mime = (info.mimeType || "").toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.has(mime)) {
        stream.resume();
        if (!rejected) {
          rejected = true;
          reject(new Error("Image must be JPEG, PNG or WebP"));
        }
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => {
        if (!rejected) {
          rejected = true;
          reject(new Error("Image must be 2MB or smaller"));
        }
      });
      stream.on("end", () => {
        if (rejected) return;
        file = {
          buffer: Buffer.concat(chunks),
          mime,
          filename: info.filename || "image",
        };
      });
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("error", (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });

    busboy.on("finish", () => {
      if (!rejected) resolve({ fields, file });
    });

    req.pipe(busboy);
  });
}
