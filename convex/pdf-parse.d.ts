declare module "pdf-parse" {
  export default function parse(buffer: Buffer): Promise<{ text: string }>;
}
