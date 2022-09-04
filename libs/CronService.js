import { CronServiceError } from '../utils/errors.js';

export class CronService {
  constructor(task, period, firstDelay = 0) {
    if (!task || (typeof task !== 'function')) {
      throw new CronServiceError('task must be a function');
    }
    this.period = period;
    this.firstDelay = firstDelay;
    this.task = task;
    this.state = 'init';
    this.timerId = [];
  }

  async start() {
    if (this.state === 'init') {
      this.state = 'started';
      const f = () => {
        const timerId = setTimeout(() => {
          this.task().finally(() => f());
        }, this.period);
        this.timerId.push(timerId);
      };
      const timerId = setTimeout(() => f(), this.firstDelay);
      this.timerId.push(timerId);
    }

    this.state = 'stopped';

    return true;
  }

  async stop() {
    this.timerId.forEach((timerId) => clearTimeout(timerId));
    this.timerId = [];
    this.state = 'terminated';
  }
}
