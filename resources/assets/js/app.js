var React = require('react');
var TimerMixin = require('react-timer-mixin');
var ReactDOM = require('react-dom');
var Remarkable = require('remarkable');
var RemarkableEmoji = require('remarkable-emoji');
var twemoji = require('twemoji');
var ColorBag = require('./colorbag');
var Confetti = require('./confetti');

import _ from 'lodash';
import FlipMove from 'react-flip-move';
import ColorPicker from 'react-color';

var MIN_STROKE_DIST_SQ = Math.pow(5, 2);

var rushPhase = false;
var startX = 0;
var startY = 0;

var joinSound = new Audio("/static/snd/join.mp3");
var partSound = new Audio("/static/snd/part.mp3");
var sendSound = new Audio("/static/snd/send.mp3");
var winSound = new Audio("/static/snd/win.mp3");
var roundStartSound = new Audio("/static/snd/round_start.mp3");
var drawStartSound = new Audio("/static/snd/draw_start.mp3");
var correctGuessSound = new Audio("/static/snd/correct_guess.mp3");
var rushPhaseSound = new Audio("/static/snd/rush_phase.mp3");
var tickingSound = new Audio("/static/snd/ticking.mp3");

tickingSound.addEventListener('timeupdate', function () {
  if (rushPhase && this.currentTime > this.duration - 0.5) {
    this.currentTime = 0;
    this.play();
  }
}, false);

var socket = io.connect('http://' + document.domain + ':' + location.port, {
  tryTransportsOnConnectTimeout: true,
  rememberTransport: false,
  reconnection: false
});

socket.on('error', function (e) {
  alert(e);
});

socket.on('alert', function (e) {
  alert(e.message);
});

socket.on('login', function (data) {
  socket.emit('join_room', {room: 'default'});
});

socket.on('state', function (data) {
  rushPhase = false;
  tickingSound.pause();
  tickingSound.currentTime = 0;

  var state = data.state;
  switch (state) {
    case 'wait':
      break;
    case 'draw':
      drawStartSound.play();
      break;
    case 'guess':
      roundStartSound.play();
      break;
    case 'score':
      winSound.play();
      break;
  }
});

socket.on('correct_guess', function (data) {
  correctGuessSound.play();
});

socket.on('rush_phase', function (data) {
  rushPhase = true;
  rushPhaseSound.play();
  tickingSound.play();
});

var md = new Remarkable('default', {
  html: false,
  linkify: true,
  typographer: false
});
md.core.ruler.disable([
  'references',
  'abbr2',
  'footnote_tail'
]);
md.block.ruler.disable([
  'blockquote',
  'fences',
  'heading',
  'hr',
  'htmlblock',
  'lheading',
  'list',
  'table'
]);
md.inline.ruler.disable([
  'footnote_ref',
  'htmltag',
  'links'
]);
md.use(RemarkableEmoji);

var Chat = React.createClass({
  getInitialState: function() {
    this.lastIndex = 0;
    this.colorBag = new ColorBag.ColorBag();
    return {messages: []};
  },
  componentWillMount: function() {
    socket.on('chat', (msg) => {
      this.setState((state) => {
        msg['id'] = this.lastIndex++;
        state.messages.push(msg);
        return state;
      });
    });
  },
  componentDidMount: function() {
    var node = ReactDOM.findDOMNode(this);
    $(node).on("click", "a", function (e) {
      e.preventDefault();
      window.open($(this).attr('href'));
    });
  },
  componentWillUpdate: function() {
    var node = ReactDOM.findDOMNode(this);
    this.shouldScroll = node.scrollTop + node.clientHeight > node.scrollHeight - 100;
  },
  componentDidUpdate: function() {
    if (this.shouldScroll) {
      var node = ReactDOM.findDOMNode(this);
      node.scrollTop = node.scrollHeight;
    }
  },
  render: function() {
    var messages = this.state.messages.map((m) => {
      if ('name' in m) {
        var color = this.colorBag.getColor(m.name);
        return (
          <li key={m.id} className={"msg-" + m.type}>
            <div className="name" style={{color: color}}>{m.name}</div>
            <div className="message" dangerouslySetInnerHTML={{__html: twemoji.parse(md.render(m.msg), {size: 16})}}></div>
          </li>
        );
      } else {
        return (
          <li key={m.id} className={"msg-" + m.type} dangerouslySetInnerHTML={{__html: twemoji.parse(md.render(m.msg), {size: 16})}}/>
        );
      }
    });
    return (
      <ul id="chat">
        {messages}
      </ul>
    );
  }
});

var ChatForm = React.createClass({
  getInitialState: function() {
    return {'message': ''};
  },
  componentWillMount: function() {
    socket.on('state', (data) => {
      this.setState({canChat: data.state != "draw"})
    });
  },
  componentDidUpdate: function() {
    ReactDOM.findDOMNode(this).querySelector('#message').focus();
  },
  handleMessageChange: function(e) {
    this.setState({message: e.target.value});
  },
  handleSubmit: function(e) {
    e.preventDefault();
    if (this.state.message.length > 0) {
      socket.emit('say', {
        msg: this.state.message
      });
      this.setState({message: ''});
      sendSound.play();
    }
  },
  render: function() {
    if (this.state.canChat) {
      return (
        <form id="chat-form" onSubmit={this.handleSubmit}>
          <div id="message-container">
            <input type="text" id="message" placeholder="Type your guesses or messages here..."
                   value={this.state.message} onChange={this.handleMessageChange}/>
          </div>
          <label className="sr-only" htmlFor="message">Message:</label>
          <button className="sr-only btn btn-default" type="submit">Send</button>
        </form>
      );
    } else {
      return (
        <form id="chat-form" onSubmit={this.handleSubmit}>
          <div id="message-container">
            <input type="text" id="message" placeholder="No chatting when drawing!" disabled/>
          </div>
          <label className="sr-only" htmlFor="message">Message:</label>
        </form>
      );
    }
  }
});


var AwayPanel = React.createClass({
  getInitialState: function() {
    return {away: false}
  },
  componentWillMount: function() {
    socket.on('connect', () => {
      socket.emit('away', {
        away: this.state.away
      });
    });

    socket.on('me', (data) => {
      this.setState({away: data.away})
    });
  },
  handleChange: function(e) {
    var away = e.target.checked;
    this.setState({away: away});
    socket.emit('away', {
      away: away
    });
  },
  render: function() {
    return (
      <div id="away-panel">
        <label><input type="checkbox" onChange={this.handleChange} checked={this.state.away} /> I'm preoccupied so don't make me draw</label>
      </div>
    );
  }
});


var UserList = React.createClass({
  userSortFn: function(a, b) {
    if (a.score == b.score) {
      return 0;
    } else {
      return a.score > b.score ? -1 : 1;
    }
  },
  getInitialState: function() {
    return {users: []};
  },
  componentWillMount: function() {
    socket.on('users', (data) => {
      this.setState({users: data.users});
    });

    socket.on('join', (data) => {
      joinSound.play();
      this.setState({users: this.state.users.concat([data])});
    });

    socket.on('part', (data) => {
      partSound.play();
      this.setState({users: this.state.users.filter((u) => u.name != data.name)});
    });

    socket.on('state', (data) => {
      this.state.users.forEach((u) => {
        u.drawing = 'artists' in data && _.includes(data.artists, u.name);
        u.guessed = false;
      });

      this.setState({
        users: this.state.users
      });
    });

    socket.on('scores', (data) => {
      this.setState((state) => {
      for (var i = 0; i < data.scores.length; i++) {
        var entry = data.scores[i];
        var user = _.find(this.state.users, (u) => u.name == entry.name);
          user.score = entry.score;
          if (entry.guessed) {
            user.guessed = true;
          }
        }
        this.state.users.sort(this.userSortFn);
        return state;
      });
    });

    socket.on('status', (data) => {
      var user = _.find(this.state.users, (u) => u.name == data.name);
      this.setState((state) => {
        user.away = data.away;
        return state;
      });
    });

    socket.on('reset_scores', (data) => {
      this.setState((state) => {
        state.users.forEach(u => u.score = 0);
        return state;
      });
    });
  },
  render: function() {
    var users = this.state.users.map((user) => {
      return (
        <li key={user.name} className={(user.drawing ? 'drawing ' : '') + (user.guessed ? 'guessed ' : '') + (user.away ? 'away ' : '')}>
          <span className="badge score">{user.score}</span>
          {user.name}
          <i className="fa fa-paint-brush artist-indicator"/>
        </li>
      );
    });
    return (
      <ul id="users">
        <FlipMove easing="ease-in-out">
        {users}
        </FlipMove>
      </ul>
    );
  }
});

var Canvas = React.createClass({
  getInitialState: function() {
    return {
      tool: 'line'
    };
  },
  clear: function() {
    var canvas = ReactDOM.findDOMNode(this);
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  },
  componentDidMount: function() {
    var canvas = ReactDOM.findDOMNode(this);
    var ctx = canvas.getContext("2d");
    var painting = false;

    socket.on('state', data => {
      this.clear();
    });

    socket.on('draw', msg => {
      switch (msg.action) {
        case 'line':
          ctx.strokeStyle = msg.color;
          ctx.lineJoin = "round";
          ctx.lineWidth = msg.thickness;
          ctx.beginPath();
          ctx.moveTo(msg.x0, msg.y0);
          ctx.lineTo(msg.x1, msg.y1);
          ctx.closePath();
          ctx.stroke();
          break;
        case 'clear':
          this.clear();
          break;
      }
    });

    canvas.addEventListener("mousedown", e => {
      var x = e.pageX - canvas.offsetLeft;
      var y = e.pageY - canvas.offsetTop;
      painting = this.props.canDraw;
      startX = x;
      startY = y;
    });

    canvas.addEventListener("mouseenter", e => {
      var x = e.pageX - canvas.offsetLeft;
      var y = e.pageY - canvas.offsetTop;
      startX = x;
      startY = y;
    });

    canvas.addEventListener("mousemove", e => {
      var x = e.pageX - canvas.offsetLeft;
      var y = e.pageY - canvas.offsetTop;
      var distSq = Math.pow(x - startX, 2) + Math.pow(y - startY, 2);

      if (this.props.canDraw && painting && distSq > MIN_STROKE_DIST_SQ) {
        var thickness, color;

        switch (this.props.tool) {
          case 'eraser':
            thickness = 20;
            color = '#fff';
            break;
          default:
            thickness = 2;
            color = this.props.color;
        }

        ctx.strokeStyle = color;
        ctx.lineJoin = "round";
        ctx.lineWidth = thickness;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(x, y);
        ctx.closePath();
        ctx.stroke();

        socket.emit('draw', {
          action: 'line',
          x0: startX,
          y0: startY,
          x1: x,
          y1: y,
          thickness: thickness,
          color: color
        });

        startX = x;
        startY = y;
      }
    });

    window.addEventListener("mouseup", e => {
      painting = false;
    });
  },
  render: function() {
    return (
      <canvas id="draw-canvas" width="500" height="500"/>
    );
  }
});

var DrawPanel = React.createClass({
  getInitialState: function() {
    return {
      state: 'wait',
      color: '#000',
      tool: 'line',
      can_skip: true,
      hints_remaining: 2
    };
  },
  componentWillMount: function() {
    socket.on('state', (data) => {
      this.setState(data);
    });

    socket.on('round', (data) => {
      this.setState(data);
    });
  },
  handleColorChange: function(color) {
    this.setState({color: '#' + color.hex});
  },
  clear: function() {
    socket.emit('draw', {
      action: 'clear'
    });
    this.refs.canvas.clear();
  },
  setTool: function(tool) {
    this.setState({tool: tool});
  },
  handleHint: function() {
    socket.emit('hint', {});
  },
  handleSkip: function() {
    socket.emit('skip', {});
  },
  render: function() {
    if (this.state.state == 'draw') {
      return (
        <div>
          <Canvas ref="canvas" canDraw={true} color={this.state.color} tool={this.state.tool} />
          <div id="toolbox">
            <div className="draw-controls">
              <div id="color-picker">
                <ColorPicker type="compact" onChange={this.handleColorChange} color={this.state.color} />
              </div>
              <button className="btn btn-default btn-lg" onClick={this.clear}><i className="fa fa-file-o"/></button>
              <button className={"btn btn-default btn-lg" + (this.state.tool == 'line' ? ' active' : '')}
                      onClick={() => this.setTool('line')}>
                <i className="fa fa-paint-brush"/>
              </button>
              <button className={"btn btn-default btn-lg" + (this.state.tool == 'eraser' ? ' active' : '')}
                      onClick={() => this.setTool('eraser')}>
                <i className="fa fa-eraser"/>
              </button>
            </div>
            <div className="round-controls">
              <button className="btn btn-warning btn-sm" onClick={this.handleHint} disabled={this.state.hints_remaining == 0}>Give hint</button>
              <button className="btn btn-danger btn-sm" onClick={this.handleSkip} disabled={!this.state.can_skip}>Skip</button>
            </div>
          </div>
        </div>
      );
    } else {
      return (
        <div>
          <Canvas canDraw={false}/>
        </div>
      );
    }
  }
});

var ProgressPie = React.createClass({
  mixins: [TimerMixin],
  componentDidMount: function() {
    var canvas = ReactDOM.findDOMNode(this);
    var ctx = canvas.getContext("2d");
    var cx = canvas.width / 2;
    var cy = canvas.height / 2;

    this.setInterval(
      () => {
        var now = new Date().getTime() / 1000;
        var progress = Math.min(1, (now - this.props.startTime) / (this.props.endTime - this.props.startTime));

        ctx.fillStyle = this.props.color;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, canvas.width / 2, -Math.PI / 2, 2 * Math.PI * progress  -Math.PI / 2);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.fill();
      },
      50
    );
  },
  render: function() {
    return (
      <canvas width={this.props.width} height={this.props.width} className="pie-progress"/>
    );
  }
});

var ConfettiCanvas = React.createClass({
  componentDidMount: function() {
    var canvas = ReactDOM.findDOMNode(this);
    this.confetti = new Confetti.Context(canvas);
    this.confetti.start();
  },
  componentWillUnmount: function() {
    this.confetti.stop();
  },
  render: function() {
    return (
      <canvas width="1" height="1"/>
    );
  }
});

var HelpPanel = React.createClass({
  getInitialState: function() {
    return {
      state: 'wait',
      hint: null
    };
  },
  componentWillMount: function() {
    socket.on('state', (data) => {
      if ('elapsed_time' in data) {
        var now = new Date().getTime() / 1000;
        data.start_time = now - data.elapsed_time;
        data.end_time = now + data.remaining_time;
      }

      this.setState(data);
    });

    socket.on('hint', (data) => {
      this.setState(data);
    });

    socket.on('rush_phase', (data) => {
      this.setState((d) => {
        d.rush_phase = true;
        var now = new Date().getTime() / 1000;
        d.start_time = now - data.elapsed_time;
        d.end_time = now + data.remaining_time;
        return d;
      });
    });
  },
  render: function() {
    switch (this.state.state) {
      case "wait":
        return (
          <div id="help">
            <i className="fa fa-refresh fa-spin"/> Invite some players so the game can start!
          </div>
        );

      case "draw":
          if (this.state.hint !== null) {
            return (
              <div id="help">
                <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time} color={this.state.rush_phase ? "#F37865" : "#555"}/>
                <strong className="phrase-small">{this.state.phrase}</strong>
                <div className="hint"><strong>Everyone sees this hint:</strong> <span className="hint-letters">{this.state.hint}</span></div>
              </div>
            );
          } else {
            return (
              <div id="help">
                <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time}
                             color={this.state.rush_phase ? "#F37865" : "#555"}/>
                In the space below, draw this word: <strong className="phrase">{this.state.phrase}</strong>
              </div>
            );
          }

      case "guess":
        if (this.state.hint !== null) {
            return (
              <div id="help">
                <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time} color={this.state.rush_phase ? "#F37865" : "#555"}/>
                Guess the word for the picture below!
                <div className="hint"><strong>Hint:</strong> <span className="hint-letters">{this.state.hint}</span></div>
              </div>
            );
        } else {
            return (
              <div id="help">
                <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time} color={this.state.rush_phase ? "#F37865" : "#555"}/>
                Guess the word for the picture below!
              </div>
            );
        }

      case "score":
        return (
          <div></div>
        );
    }
  }
});

var ScoreScreen = React.createClass({
  getInitialState: function() {
    return {
      state: 'wait'
    };
  },
  componentWillMount: function() {
    socket.on('state', (data) => {
      this.setState(data);
    });
  },
  render: function() {
    switch (this.state.state) {
      case "score":
        if (this.state.scores.length > 0 && this.state.scores[0].score > 0) {
          var topScore = this.state.scores[0].score;
          var winners = this.state.scores.filter(e => e.score == topScore);
          var results = winners.map((e) => {
            return (
              <li key={e.name}>{e.name}</li>
            );
          });

          return (
            <div id="score-screen">
              <ConfettiCanvas/>
              <div id="score-text">
                <p className="have-winners">Our winners:</p>
                <ul className="winners">
                  {results}
                </ul>
                <p className="next-round-shortly">The next game will begin shortly.</p>
              </div>
            </div>
          );
        } else {
          return (
            <div id="score-screen">
              <ConfettiCanvas/>
              <div id="score-text">
                <p className="no-winners">No one won the game.</p>
                <p className="next-round-shortly">The next game will begin shortly.</p>
              </div>
            </div>
          );
        }

      default:
        return (
          <div></div>
        )
    }
  }
});

var Login = React.createClass({
  getInitialState: function() {
    return {
      name: localStorage.sketchName || '',
      logging_in: false,
      connected: false,
      joined: false
    }
  },
  componentWillMount: function() {
    socket.on('connect', () => {
      this.setState({connected: true, joined: false})
    });
    socket.on('disconnect', () => {
      this.setState({connected: false, joined: false, logging_in: false})
    });
    socket.on('join_room', () => {
      this.setState({joined: true, logging_in: false})
    });
    socket.on('alert', () => {
      this.setState({logging_in: false})
    });
  },
  handleNameChange: function(e) {
    var text = e.target.value;
    this.setState({name: text});
  },
  handleSubmit: function(e) {
    e.preventDefault();
    if (this.state.connected) {
      this.setState({logging_in: true});
      socket.emit('login', {username: this.state.name});
    } else {
      alert('Not connected yet!');
    }
  },
  render: function() {
    if (this.state.joined) {
      return (
        <div></div>
      );
    } else {
      if (this.state.logging_in) {
        return (
          <div className="backdrop">
            <div id="login">
              <p><i className="fa fa-circle-o-notch fa-spin"/> Engaging receptacles...</p>
            </div>
          </div>
        )
      } else {
        return (
          <div className="backdrop">
            <form id="login" onSubmit={this.handleSubmit}>
              <h1>
                <img src="/static/img/sketch.png"/> SKetch
              </h1>
              <p><em>SUPER ALPHA. All bugs are features.</em></p>
              <p>What's your name?</p>
              <p><input type="text" className="form-control" value={this.state.name} placeholder="Pick a game name..." onChange={this.handleNameChange}/></p>
              <p><button type="submit" className="btn btn-default">Let's play!</button></p>
            </form>
          </div>
        )
      }
    }
  }
});

ReactDOM.render(
  <div>
    <div id="header"><img src="/static/img/sketch.png"/> SKetch</div>
    <HelpPanel/>
    <AwayPanel/>
    <DrawPanel/>
    <UserList/>
    <Chat/>
    <ChatForm/>
    <ScoreScreen/>
    <Login/>
  </div>,
  document.getElementById('container')
);