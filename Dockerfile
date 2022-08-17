FROM node:16-alpine

WORKDIR /usr/src/app/backend

RUN apk update
RUN apk add --update-cache \
    bash \
    nano \
    make