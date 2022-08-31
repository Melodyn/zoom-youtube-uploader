/* eslint-disable max-classes-per-file */

export class AppError extends Error {}

export class ConfigValidationError extends AppError {
  constructor(validationError) {
    super();
    this.name = 'Config validation error';
    this.message = validationError.errors.join('\n');
  }
}

export class CronServiceError extends AppError {}
