'use strict';

const { apiPort } = require('./config');
const fs = require('fs');
const path = require('path');

const express = require('express');
const bodyParser = require('body-parser');

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

const port = apiPort;

const router = express.Router();;

router.get('/ping', (req, res) => {
  res.json({ message: 'pong' });

});
router.get('/data', (req, res) => {
  fs.readFile(path.resolve(__dirname, 'words.txt'), 'utf-8', (err, data) => {
    if (err) throw err;
    //res.json(data.slice(0,10000));
    //res.json(data);
    setTimeout(() => {
      res.json(data);
    }, 20000);
  });
});

app.use('/api', router);
app.listen(port);

console.log(`API listening on ${port}`);
