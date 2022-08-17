V?=patch
USER_UID=$(shell id -u)
USER_GID=$(shell id -g)

setup: install-dependencies create-config run
install-dependencies:
	npm ci
create-config:
	cp -n development.env.example development.env || true

# local run
run:
	NODE_ENV=development npx nodemon ./bin/index.js
run-heroku:
	NODE_ENV=development heroku local web
stop: stop-node
stop-node:
	kill -15 `pidof node` || true

# dev
lint:
	npx eslint .
test:
	NODE_ENV=test npm test -s
test-dev:
	NODE_ENV=test npm test -s -- --watchAll
test-cov:
	NODE_ENV=test npm run test-cov
version:
	npm version ${V} && git push --tags
dep-update:
	npx npm-check-updates -u

# usage with docker
container-setup: container-build container-dependency container-run
container-build:
	docker-compose build
container-dependency:
	docker-compose run --rm -u $(USER_UID):$(USER_GID) backend make install-dependencies
container-run: create-config
	docker-compose run --rm -u $(USER_UID):$(USER_GID) -p 5000:5000 backend /bin/bash
container-test:
	docker-compose run --rm -u $(USER_UID):$(USER_GID) backend make test
