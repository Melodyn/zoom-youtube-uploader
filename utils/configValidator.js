import yup from 'yup';
import path from 'path';
import _ from 'lodash';
import dotenv from 'dotenv';
import { ConfigValidationError } from './errors.js';
import { __dirname } from './helpers.js';

const envsMap = {
  prod: 'production',
  dev: 'development',
  test: 'test',
};

const readFromFile = (configPath) => dotenv.config({
  path: path.resolve(__dirname, '..', configPath),
}).parsed;
const envConfigMap = {
  [envsMap.prod]: process.env,
  [envsMap.dev]: readFromFile('development.env'),
  [envsMap.test]: readFromFile('test.config'),
};

const checkEnv = (expected) => (current, schema) => schema.default(current === expected);

const configSchema = yup.object({
  NODE_ENV: yup.string().oneOf(_.values(envsMap)).required(),
  IS_TEST_ENV: yup.boolean().when('NODE_ENV', checkEnv(envsMap.test)),
  IS_DEV_ENV: yup.boolean().when('NODE_ENV', checkEnv(envsMap.dev)),
  IS_PROD_ENV: yup.boolean().when('NODE_ENV', checkEnv(envsMap.prod)),
  PORT: yup.number().required(),
  HOST: yup.string().required(),
  LOG_LEVEL: yup.string().required(),
  ROUTE_UUID: yup.string().required(),
  CRON_PERIOD: yup.string().required(),
  CRON_DELAY: yup.string().required(),
  STORAGE_DIRPATH: yup.string()
    .transform((_, paths) => path.resolve(__dirname, ...paths.split(',')))
    .required(),
}).required();

const configValidator = (envName) => {
  const envExists = _.has(envConfigMap, envName);
  if (!envExists) throw new Error(`Unexpected env "${envName}"`);
  const envConfig = envConfigMap[envName];

  return configSchema
    .validate(envConfig, { abortEarly: false })
    .catch((err) => {
      console.error(err);
      throw new ConfigValidationError(err);
    });
};

export default configValidator;
