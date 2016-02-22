'use strict';

var Remarkable = require('remarkable');
var RemarkableEmoji = require('remarkable-emoji');
var twemoji = require('twemoji');

export const MarkdownMixin = {
  componentWillMount: function() {
    this.md = new Remarkable('default', {
      html: false,
      linkify: true,
      typographer: false
    });

    this.md.core.ruler.disable([
      'references',
      'abbr2',
      'footnote_tail'
    ]);

    this.md.block.ruler.disable([
      'blockquote',
      'fences',
      'heading',
      'hr',
      'htmlblock',
      'lheading',
      'list',
      'table'
    ]);

    this.md.inline.ruler.disable([
      'footnote_ref',
      'htmltag',
      'links'
    ]);

    this.md.use(RemarkableEmoji);
  },
  renderMarkup: function(text) {
    return twemoji.parse(this.md.render(text), {size: 16});
  }
};