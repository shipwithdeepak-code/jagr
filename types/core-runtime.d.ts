/**
 * The ONLY runtime globals the portable core (src/product) may use — web-standard APIs present in
 * browsers, Node ≥18, Deno and edge runtimes alike. Everything else (fetch, window, localStorage,
 * process, Buffer…) is unavailable to the core by construction: I/O comes in through ports.
 * Included by tsconfig.product.json only; the app build uses the full DOM / Node typings.
 */
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;

declare class URL {
  constructor(url: string, base?: string);
  readonly host: string;
  readonly hostname: string;
  readonly protocol: string;
  readonly href: string;
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null; set(name: string, value: string): void; append(name: string, value: string): void };
  toString(): string;
}

interface AbortSignal {
  readonly aborted: boolean;
}
declare var AbortSignal: { timeout(ms: number): AbortSignal };
