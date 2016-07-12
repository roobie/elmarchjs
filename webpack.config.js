const path = require('path');

module.exports = {
  devtool: '#inline-source-map',
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
        loader: 'babel-loader'
      }, {
        test: /\.css$/,
        loader: "style-loader!css-loader"
      },
      {
        test: /\.less$/,
        loader: "style-loader!css-loader!less-loader"
      }
    ],
  },
}
