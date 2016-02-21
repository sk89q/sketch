var elixir = require('laravel-elixir');

elixir(function(mix) {
    mix.browserify([
      'app.js'
    ], 'static/js/app.js');
    mix.sass([
        'app.scss'
    ], 'static/css/app.css');
});
