export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 2,
    public operationId?: string,
  ) {
    super(message);
  }
}
