declare module "node:fs" {
  export function readFileSync(path: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
}
