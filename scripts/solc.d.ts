// Minimal ambient declaration for solc-js (the npm package ships no types).
// We only use the synchronous standard-JSON compiler entry point.
declare module 'solc' {
  interface SolcStandardJsonOutput {
    errors?: { severity: string; formattedMessage: string }[]
    contracts: Record<
      string,
      Record<
        string,
        {
          abi: unknown
          evm: { bytecode: { object: string } }
        }
      >
    >
  }
  export function compile(input: string): string
  export function version(): string
}
