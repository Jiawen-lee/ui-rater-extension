export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export class ContractError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ContractError) {
    return { error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } };
  }
  return {
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'Unexpected error',
      retryable: false,
    },
  };
}
