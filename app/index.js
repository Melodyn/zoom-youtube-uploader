import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
// fastify
import fastify from 'fastify';
// libs

// app
import configValidator from '../utils/configValidator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const bodyFixture = {
  hello: "world"
};

const initServer = (config) => {
  const pinoPrettyTransport = {
    transport: {
      target: 'pino-pretty',
    },
  };
  const transport = config.IS_DEV_ENV ? pinoPrettyTransport : {};
  const server = fastify({
    logger: {
      ...transport,
      level: config.LOG_LEVEL,
    },
  });

  const route = {
    method: 'POST',
    url: `/${config.ROUTE_UUID}`,
    handler(req, res) {
      const { body } = req;

      this.storage.write(bodyFixture);

      res.code(200).send('ok');
    },
  };

  server.route(route);

  return server;
};

const initIncomingDataStorage =  async (server) => {
  const filepath = path.join(__dirname, '..', 'data', 'incoming.json');

  return fs
    .promises
    .readFile(filepath)
    .then((data) => {
      const json = JSON.parse(data);
      console.log({ json });

      const storage = {
        write: (data) => {
          json.push(data);
          return fs
            .promises
            .writeFile(filepath, JSON.stringify(json));
        },
      };

      server.decorate('storage', storage);
    });
};

const app = async (envName) => {
  process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
  });

  const config = await configValidator(envName);
  const server = initServer(config);
  await initIncomingDataStorage(server);

  server.decorate('config', config);

  const stop = async () => {
    server.log.info('Stop app', config);
    server.log.info('  Stop server');
    await server.close();
    server.log.info('App stopped');

    if (!config.IS_TEST_ENV) {
      process.exit(0);
    }
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await server.listen({ port: config.PORT, host: config.HOST });

  return {
    server,
    config,
    stop,
  };
};

export default app;
