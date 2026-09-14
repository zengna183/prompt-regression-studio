export class RepositoryError extends Error {
  override readonly name: string = "RepositoryError";
}

export class EntityNotFoundError extends RepositoryError {
  override readonly name = "EntityNotFoundError";
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.entity = entity;
    this.id = id;
  }
}

export class RepositoryConflictError extends RepositoryError {
  override readonly name = "RepositoryConflictError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class InvalidVersionStateError extends RepositoryError {
  override readonly name = "InvalidVersionStateError";
  readonly status: string;

  constructor(status: string, message: string) {
    super(message);
    this.status = status;
  }
}
