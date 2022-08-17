// fastify
import fastify from 'fastify';
// libs

// app
import configValidator from '../utils/configValidator.js';

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

      res.code(200).send(body);
    },
  };

  server.route(route);

  return server;
};

const app = async (envName) => {
  process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
  });

  const config = await configValidator(envName);
  const server = initServer(config);

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
