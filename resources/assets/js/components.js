'use strict';

import React from 'react';
import ReactDOM from 'react-dom';
import ReactCSSTransitionGroup from 'react-addons-css-transition-group';
import TimerMixin from 'react-timer-mixin';
import _ from 'lodash';
import FlipMove from 'react-flip-move';
import ColorPicker from 'react-color';
import Trianglify from 'trianglify';
import Confetti from './confetti';
import { TransportMixin, DISCONNECTED, CONNECTING, CONNECTED, LOGGED_IN } from './transport';
import { Pen, NetworkedCanvas } from './pen';
import ColorBag from './colorbag';
import MarkdownMixin from './markup';

var MIN_STROKE_DIST_SQ = Math.pow(3, 2);

var sendSound = new Audio("/static/snd/send.mp3");

export const MessageList = React.createClass({
  lastIndex: 0,
  colorBag: new ColorBag(),
  mixins: [
    MarkdownMixin,
    TransportMixin
  ],
  getInitialState: function () {
    return {
      messages: []
    };
  },
  componentWillMount: function () {
    this.addTransportHandler('chat', msg => {
      msg.id = this.lastIndex++;
      this.setState({messages: this.state.messages.concat([msg])});
    });
  },
  componentDidMount: function () {
    $(this.refs.container).on("click", "a", function (e) {
      e.preventDefault();
      window.open($(this).attr('href'));
    });
  },
  componentWillUpdate: function () {
    this.shouldScroll = this.refs.container.scrollTop + this.refs.container.clientHeight > this.refs.container.scrollHeight - 100;
  },
  componentDidUpdate: function () {
    if (this.shouldScroll) {
      this.refs.container.scrollTop = this.refs.container.scrollHeight;
    }
  },
  render: function () {
    var messages = this.state.messages.map((m) => {
      return (
        <li key={m.id} className={"msg-" + m.type}>
          { 'name' in m ? <div className="name" style={{color: this.colorBag.getColor(m.name)}}>{m.name}</div> : null }
          <div className="message" dangerouslySetInnerHTML={{__html: this.renderMarkup(m.msg)}}></div>
        </li>
      );
    });

    return (
      <ul id="chat" ref="container">
        <ReactCSSTransitionGroup transitionName="slide" transitionEnterTimeout={200} transitionLeaveTimeout={200}>
          {messages}
        </ReactCSSTransitionGroup>
      </ul>
    );
  }
});

export const ChatForm = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {message: ''};
  },
  componentWillMount: function () {
    this.addTransportHandler('state', data => {
      this.setState({canChat: data.state != "draw"})
    });
  },
  componentDidUpdate: function () {
    this.refs.message.focus();
  },
  handleMessageChange: function (e) {
    this.setState({message: e.target.value});
  },
  handleSubmit: function (e) {
    e.preventDefault();
    if (this.state.message.length > 0) {
      this.props.transport.say(this.state.message);
      this.setState({message: ''});
      sendSound.play();
    }
  },
  render: function () {
    return (
      <form id="chat-form" onSubmit={this.handleSubmit}>
        <div id="message-container">
          <input type="text" id="message" ref="message"
                 placeholder={this.state.canChat ? 'Type your guesses or messages here...' : 'No chatting when drawing!'}
                 value={this.state.message} onChange={this.handleMessageChange} disabled={!this.state.canChat}/>
        </div>
        <label className="sr-only" htmlFor="message">Message:</label>
        <button className="sr-only btn btn-default" type="submit">Send</button>
      </form>
    );
  }
});

export const AwayPanel = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {away: false}
  },
  componentWillMount: function () {
    this.addTransportHandler('me', data => {
      this.setState({away: data.away})
    });
  },
  handleChange: function (e) {
    var away = e.target.checked;
    this.setState({away: away});
    this.props.transport.setAway(away);
  },
  render: function () {
    return (
      <div id="away-panel">
        <label><input type="checkbox" onChange={this.handleChange} checked={this.state.away}/>
          I'm preoccupied so don't make me draw</label>
      </div>
    );
  }
});

export const UserList = React.createClass({
  mixins: [
    TransportMixin
  ],
  userSortFn: function (a, b) {
    if (a.score == b.score) {
      return 0;
    } else {
      return a.score > b.score ? -1 : 1;
    }
  },
  getInitialState: function () {
    var users = [];
    if (this.props.transport.room !== null) {
      users = this.props.transport.room.users.slice(0);
      users.sort(this.userSortFn);
    }
    return {users: users};
  },
  componentWillMount: function () {
    this.addTransportHandler('users', (data) => {
      var users = data.slice(0);
      users.sort(this.userSortFn);
      this.setState({users: users});
    });
  },
  render: function () {
    var users = this.state.users.map((user) => {
      return (
        <li key={user.name}
            className={(user.drawing ? 'drawing ' : '') + (user.guessed ? 'guessed ' : '') + (user.away ? 'away ' : '')}>
          <span className="badge score">{user.score || '0'}</span>
          {user.name}
          <i className="fa fa-paint-brush artist-indicator"/>
        </li>
      );
    });
    return (
      <ul id="users">
        <ReactCSSTransitionGroup transitionName="slide" transitionEnterTimeout={200} transitionLeaveTimeout={200}>
          <FlipMove easing="ease-in-out">
            {users}
          </FlipMove>
        </ReactCSSTransitionGroup>
      </ul>
    );
  }
});

export const Canvas = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {
      tool: 'line'
    };
  },
  clear: function () {
    var canvas = this.refs.canvas;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  },
  componentDidMount: function () {
    var canvas = this.refs.canvas;
    var ctx = canvas.getContext("2d");
    var painting = false;
    var startX = 0;
    var startY = 0;

    this.localPen = new Pen(canvas);
    this.networkedCanvas = new NetworkedCanvas(canvas);

    this.localPen.writePacket = buffer => {
      this.props.transport.draw(buffer);
    };

    this.addTransportHandler('state', data => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.localPen.reset();
      this.localPen.setColor(this.props.color[0], this.props.color[1], this.props.color[2]);
      this.localPen.setLineWidth(2);
      this.networkedCanvas.reset();
    });

    this.addTransportHandler('draw', msg => {
      this.networkedCanvas.read(msg);
    });

    canvas.addEventListener("mousedown", e => {
      e.preventDefault();
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

    var mouseMove = e => {
      var x = e.pageX - canvas.offsetLeft;
      var y = e.pageY - canvas.offsetTop;
      var distSq = Math.pow(x - startX, 2) + Math.pow(y - startY, 2);

      if (this.props.canDraw && painting && distSq > MIN_STROKE_DIST_SQ) {
        var thickness, color;

        switch (this.props.tool) {
          case 'eraser':
            this.localPen.setLineWidth(20);
            this.localPen.setColor(255, 255, 255);
            this.localPen.moveTo(startX, startY);
            this.localPen.lineTo(x, y);
            break;
          default:
            this.localPen.setLineWidth(2);
            this.localPen.setColor(this.props.color[0], this.props.color[1], this.props.color[2]);
            this.localPen.moveTo(startX, startY);
            this.localPen.lineTo(x, y);
            break;
        }

        startX = x;
        startY = y;
      }
    };

    canvas.addEventListener("mouseleave", mouseMove);

    canvas.addEventListener("mousemove", mouseMove);

    window.addEventListener("mouseup", e => {
      painting = false;
    });
  },
  render: function () {
    return (
      <canvas ref="canvas" id="draw-canvas" width="600" height="400"/>
    );
  }
});

export const DrawPanel = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {
      state: 'wait',
      color: {r: 0, g: 0, b: 0},
      tool: 'line',
      can_skip: true,
      hints_remaining: 2
    };
  },
  componentWillMount: function () {
    this.addTransportHandler('state', data => {
      this.setState(data);
    });

    this.addTransportHandler('state_update', data => {
      this.setState(data);
    });
  },
  handleColorChange: function (color) {
    this.setState({color: color.rgb});
  },
  clear: function () {
    this.refs.canvas.localPen.clear();
  },
  setTool: function (tool) {
    this.setState({tool: tool});
  },
  handleHint: function () {
    this.props.transport.requestHint();
  },
  handleSkip: function () {
    this.props.transport.requestSkip();
  },
  render: function () {
    if (this.state.state == 'draw') {
      return (
        <div>
          <Canvas ref="canvas" canDraw={true} color={[this.state.color.r, this.state.color.g, this.state.color.b]}
                  tool={this.state.tool} transport={this.props.transport}/>
          <div id="toolbox">
            <div className="draw-controls">
              <div id="color-picker">
                <ColorPicker type="compact" onChange={this.handleColorChange} color={this.state.color}/>
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
              <button className="btn btn-warning btn-sm" onClick={this.handleHint}
                      disabled={this.state.hints_remaining == 0}>Give hint
              </button>
              <button className="btn btn-danger btn-sm" onClick={this.handleSkip} disabled={!this.state.can_skip}>Skip
              </button>
            </div>
          </div>
        </div>
      );
    } else {
      return (
        <div>
          <Canvas canDraw={false} transport={this.props.transport}
                  color={[this.state.color.r, this.state.color.g, this.state.color.b]}/>
        </div>
      );
    }
  }
});

export const ProgressPie = React.createClass({
  mixins: [
    TimerMixin
  ],
  componentDidMount: function () {
    var canvas = this.refs.canvas;
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
        ctx.arc(cx, cy, canvas.width / 2, -Math.PI / 2, 2 * Math.PI * progress - Math.PI / 2);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.fill();
      },
      50
    );
  },
  render: function () {
    return (
      <canvas ref="canvas" width={this.props.width} height={this.props.width} className="pie-progress"/>
    );
  }
});

export const ConfettiCanvas = React.createClass({
  componentDidMount: function () {
    var canvas = this.refs.canvas;
    this.confetti = new Confetti.Context(canvas);
    this.confetti.start();
  },
  componentWillUnmount: function () {
    this.confetti.stop();
  },
  render: function () {
    return (
      <canvas ref="canvas" width="1" height="1"/>
    );
  }
});

export const HelpPanel = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {
      state: 'wait',
      hint: null
    };
  },
  componentWillMount: function () {
    this.addTransportHandler('state', data => {
      if ('elapsed_time' in data) {
        var now = new Date().getTime() / 1000;
        data.start_time = now - data.elapsed_time;
        data.end_time = now + data.remaining_time;
      }

      this.setState(data);
    });

    this.addTransportHandler('state_update', (data) => {
      if ('elapsed_time' in data) {
        var now = new Date().getTime() / 1000;
        data.start_time = now - data.elapsed_time;
        data.end_time = now + data.remaining_time;
      }

      this.setState(data);
    });
  },
  render: function () {
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
              <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time}
                           color={this.state.rush_phase ? "#F37865" : "#555"}/>
              <strong className="phrase-small">{this.state.phrase}</strong>
              <div className="hint"><strong>Everyone sees this hint:</strong> <span
                className="hint-letters">{this.state.hint}</span></div>
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
              <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time}
                           color={this.state.rush_phase ? "#F37865" : "#555"}/>
              Guess the word for the picture below!
              <div className="hint"><strong>Hint:</strong> <span className="hint-letters">{this.state.hint}</span></div>
            </div>
          );
        } else {
          return (
            <div id="help">
              <ProgressPie width="45" height="45" startTime={this.state.start_time} endTime={this.state.end_time}
                           color={this.state.rush_phase ? "#F37865" : "#555"}/>
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

export const ScoreScreen = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {
      state: 'wait'
    };
  },
  componentWillMount: function () {
    this.addTransportHandler('state', data => {
      this.setState(data);
    });
  },
  render: function () {
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

export const SetupScreen = React.createClass({
  componentDidMount: function () {
    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  },
  componentWillUnmount: function () {
    window.removeEventListener('resize', this.handleResize);
  },
  handleResize: function () {
    var pattern = Trianglify({
      width: window.innerWidth,
      height: window.innerHeight,
      x_colors: 'Spectral',
      cell_size: 150
    });
    pattern.canvas(this.refs.background);
  },
  render: function() {
    var version = document.body.getAttribute("data-version");
    return (
      <div>
        <canvas className="background" ref="background" width="1" height="1"/>
        {this.props.children}
        <div className="version-text">{version}</div>
        <div className="by">by @sk89q</div>
      </div>
    );
  }
});

export const Login = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {
      name: localStorage.sketchName || ''
    }
  },
  handleNameChange: function (e) {
    var text = e.target.value;
    this.setState({name: text});
    this.props.transport.loginUsername = text;
  },
  handleSubmit: function (e) {
    e.preventDefault();
    this.props.transport.connect();
  },
  componentDidMount: function() {
    this.refs.username.focus();
  },
  render: function () {
    return (
      <form className="setup-window" onSubmit={this.handleSubmit}>
        <h1>
          <img src="/static/img/sketch.png"/> SKetch
        </h1>
        {
          this.props.transport.loginError != null ?
            <div className="alert alert-danger">{this.props.transport.loginError}</div> :
            <p><em>SUPER ALPHA. All bugs are features.<br/>Now featuring the Eduardo DLC.</em></p>
        }
        <p><input type="text" className="form-control" value={this.state.name} placeholder="Pick a username..."
                  ref="username" onChange={this.handleNameChange}/></p>
        <p>
          <button type="submit" className="btn btn-default">Let's play!</button>
        </p>
      </form>
    );
  }
});

export const App = React.createClass({
  mixins: [
    TransportMixin
  ],
  getInitialState: function () {
    return {status: this.props.transport.status};
  },
  componentDidMount: function () {
    this.addTransportHandler('status', data => {
      this.setState({status: data});
    });
  },
  render: function () {
    switch (this.state.status) {
      case DISCONNECTED:
        return (
          <SetupScreen>
            <Login transport={this.props.transport}/>
          </SetupScreen>
        );
      case CONNECTING:
        return (
          <SetupScreen>
            <div className="setup-window">
              <i className="fa fa-circle-o-notch fa-spin"/> Connecting...
            </div>
          </SetupScreen>
        );
      case CONNECTED:
        return (
          <SetupScreen>
            <div className="setup-window">
              <i className="fa fa-circle-o-notch fa-spin"/> Logging in...
            </div>
          </SetupScreen>
        );
      case LOGGED_IN:
        return (
          <div>
            <div id="header"><img src="/static/img/sketch.png"/> SKetch</div>
            <HelpPanel transport={this.props.transport}/>
            <AwayPanel transport={this.props.transport}/>
            <DrawPanel transport={this.props.transport}/>
            <UserList transport={this.props.transport}/>
            <MessageList transport={this.props.transport}/>
            <ChatForm transport={this.props.transport}/>
            <ScoreScreen transport={this.props.transport}/>
          </div>
        );
    }
  }
});