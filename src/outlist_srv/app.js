'use strict';

const config = require('../config');
const apiPort = config.apiPort;
const fs = require('fs');
const path = require('path');

const bluebird = require('bluebird');
const redis = require('redis');
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
const rclient = redis.createClient();

const express = require('express');
const bodyParser = require('body-parser');

//CORS middle ware
const allowCrossDomain = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:8080');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authentication');

  next();
};

const app = express();
app.use(allowCrossDomain);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const port = apiPort;

const router = express.Router();;


const users = [
  { id: 1, email: 'br@mailinator.com' },
];

const session = {
  // token->user
};

router.post('/login', (req, res) => {
  console.log(req.body);
  const user = users.filter(u => u.email === req.body.user)[0];
  if (user) {
    require('crypto').randomBytes(64, function(err, buffer) {
      const token = buffer.toString('hex');
      session[token] = user;
      return res.status(200).send(token);
    });
  } else {
    return res.status(400).end();
  }
});

app.use(function (req, res, next) {
  const auth = req.get('Authentication');
  const user = session[auth];
  if (user) {
    req.user = user;
  }
  next();
});

router.get('/data', (req, res) => {
  if (!req.user) {
    res.status(401).send('Nope');
  }

  rclient.getAsync('key').then(data => {
    res.json(JSON.parse(data));
  });
});

router.put('/data', (req, res) => {
  if (!req.user) {
    return res.status(401).send('Nope');
  }
  rclient.setAsync('key', JSON.stringify(req.body)).then(data => {
    res.json(data);
  });
});

app.use('/api', router);
app.listen(port);

console.log(`API listening on ${port}`);
