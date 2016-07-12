const path = require('path');

module.exports = {
  entry: './src/main.js',
  output: {
    path: __dirname,
    filename: 'build.js',
  },
  module: {
    loaders: [
      {
        test: /\.js?$/,
        exclude: /(node_modules)/,
        loader: 'babel'
      }, {
        test: /\.css$/,
        loader: "style!css"
      },
    ],
  },
}
