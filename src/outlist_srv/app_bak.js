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
const session = require('express-session');
const cookieParser = require('cookie-parser');

const passwordless = require('passwordless');
const TokenStore = require('passwordless-redisstore');

passwordless.init(new TokenStore());
passwordless.addDelivery(
  function(tokenToSend, uidToSend, recipient, callback) {
    const host = 'localhost:9000';
    const url = 'http://'
            + host + '?token=' + tokenToSend + '&uid='
            + encodeURIComponent(uidToSend);
    console.log(url);
    console.log({
      tokenToSend
    });
    callback(null);
  });

//CORS middle ware
const allowCrossDomain = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:8080');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  next();
};

const app = express();
app.use(allowCrossDomain);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: 'keyboard cat',
  resave: true,
  saveUninitialized: false,
}));

app.use(passwordless.sessionSupport());
app.use(passwordless.acceptToken({ successRedirect: 'http://localhost:8080' }));

const port = apiPort;

const router = express.Router();

const users = [
  { id: 1, email: 'br@mailinator.com' },
];

router.post('/sendtoken',
            passwordless.requestToken(
              function(user, delivery, callback) {
                for (var i = users.length - 1; i >= 0; i--) {
                  if(users[i].email === user.toLowerCase()) {
                    return callback(null, users[i].id);
                  }
                }
                return callback(null, null);
              }),
            function(req, res) {
              // success!
              res.json({message: 'OK'});
            });

router.get('/data', passwordless.restricted(), (req, res) => {
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
