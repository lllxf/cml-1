const { addDeprecationNotice } = require('../deprecation');
const { builder, handler } = require('../../cml/asset/publish');

exports.command = 'publish <asset>';
exports.description = false;
exports.handler = handler;
exports.builder = addDeprecationNotice({
  builder,
  notice: '"cml publish" is deprecated, please use "cml asset publish"'
});
