FROM node:16-alpine

WORKDIR /usr/src/app

RUN apk update
RUN apk add --update-cache \
    bash \
    nano \
    make
