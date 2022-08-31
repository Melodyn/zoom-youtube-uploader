import { CronServiceError } from '../utils/errors.js';
import { asyncTimeout } from '../utils/helpers.js';

const addToQueue = (f) => setTimeout();

export class CronService {
  constructor(task, period, firstDelay = 0) {
    if (!task || (typeof task !== 'function')) {
      throw new CronServiceError('task must be a function');
    }
    this.period = period;
    this.firstDelay = firstDelay;
    this.task = task;
    this.state = 'init';
    this.timerId = null;
  }

  async start() {
    if (this.state === 'init') {
      this.state = 'started';
      await asyncTimeout(this.firstDelay, () => {});

      while (this.state === 'started') {
        this.timerId = await asyncTimeout(this.period, this.task);
      }
    }

    this.state = 'stopped';

    return true;
  }

  async stop() {
    clearTimeout(this.timerId);
    this.state = 'terminated';
  }
}
