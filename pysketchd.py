import base64
import collections
import functools
import logging
import os.path
import random
import re
import struct
import time
import traceback
from io import BytesIO

import eventlet
from flask import Flask, render_template, request, send_from_directory
from flask_socketio import SocketIO, emit, disconnect
from pysketch.util import *

VALID_NAME_PATTERN = re.compile('^[A-Za-z0-9_]{2,20}$')

version = get_git_revision_hash()

app = Flask(__name__)
app.debug = False
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, heartbeat_interval=3, heartbeat_timeout=10, binary=False)

log = logging.getLogger("sketch")


class NameInUseError(Exception):
    """Raised when someone tries to use the name of someone
    else who already has the name."""


class User(object):
    """Represents a logged in user, which may or may not be in any room."""

    def __init__(self, sid, name):
        self.sid = sid
        self.name = name
        self.room = None
        self._away = False

    @property
    def away(self):
        return self._away

    @away.setter
    def away(self, value):
        self._away = value
        if self.room:
            self.room.broadcast_user_status(self)
            self.send_status()

    def send(self, event, data):
        """Send a packet to the user."""
        socketio.emit(event, data, room=self.sid)

    def send_status(self):
        """Send the user the 'me' message.

        Sent on initial login and to update the user's away status if
        it changes on the server.
        """
        self.send('me', {'name': self.name, 'away': self.away})

    def user_status(self):
        """Get the dict of user status info that gets sent to other players."""
        return {'name': self.name,
                'away': self.away}


class UserList(object):
    def __init__(self):
        self.users = {}

    def login(self, sid, name):
        for _, user in list(self.users.items()):
            if user.name and user.name.lower() == name.lower():
                raise NameInUseError()
        user = User(sid, name)
        self.users[sid] = user
        user.send_status()
        user.send('welcome', {'username': name})
        return user

    def has(self, sid):
        return self.users[sid]

    def get(self, sid):
        return self.users[sid]

    def quit(self, sid):
        if sid in self.users:
            user = self.users[sid]
            if user.room:
                user.room.part(user)
            del self.users[sid]

    def in_room(self, room):
        return [u for u in list(self.users.values()) if u.room == room]


class Pen(object):
    def __init__(self, index):
        self.index = index
        self.buffer = BytesIO()

    def clear(self):
        self.buffer = BytesIO()

    def write(self, data):
        self.buffer.write(data)

    def getvalue(self):
        return self.buffer.getvalue()


class Drawing(object):
    PACKET_CLEAR = 0
    PACKET_COLOR = 1
    PACKET_LINE_WIDTH = 2
    PACKET_MOVE_TO = 3
    PACKET_MOVE_TO_REL = 4
    PACKET_LINE_TO = 5
    PACKET_LINE_TO_REL = 6

    def __init__(self, room):
        self.room = room
        self.pens = {}
        self.next_pen_index = 0

    def draw(self, data, user):
        if user not in self.pens:
            self.pens[user] = Pen(self.next_pen_index)
            self.next_pen_index += 1

        decoded = base64.b64decode(data)
        type = struct.unpack('>B', decoded[0])
        enveloped = struct.pack('>B', self.pens[user].index) + decoded

        if type == self.PACKET_CLEAR:
            self.pens[user].clear()
        else:
            self.pens[user].write(enveloped)

        self.room.broadcast('draw', base64.b64encode(enveloped).decode('ascii'), except_for=user)

    def send_drawn(self, user):
        buffer = BytesIO()
        for pen in self.pens.values():
            buffer.write(pen.getvalue())
        user.send('draw', base64.b64encode(buffer.getvalue()).decode('ascii'))


class MessageLog(object):
    BACKLOG = 10

    def __init__(self, room):
        self.room = room
        self.log = collections.deque(maxlen=self.BACKLOG)

    def append(self, type, message, name=None):
        data = {'type': type, 'msg': message}
        if name: data['name'] = name;
        self.log.append(data)
        self.room.broadcast('chat', data)

    def broadcast(self, type, message, name=None):
        data = {'type': type, 'msg': message}
        if name: data['name'] = name;
        self.room.broadcast('chat', data)

    def send_backlog(self, user):
        for entry in self.log:
            user.send("chat", entry)


class State(object):
    def __init__(self, room):
        self.room = room

    def send_state(self, user):
        pass

    def draw(self, data, user):
        pass

    def think(self):
        pass

    def join(self, user):
        pass

    def part(self, user):
        pass

    def skip(self, user):
        pass

    def hint(self, user):
        pass

    def say(self, user, message):
        return False

    def user_status(self, user):
        return {'name': user.name}


class WaitForPlayersState(State):
    def __init__(self, room):
        super(WaitForPlayersState, self).__init__(room)

    def send_state(self, user):
        user.send('state', {
            'state': 'wait',
        })

    def think(self):
        if self.room.has_enough_players():
            self.room.transition(RoundState(self.room))


class RoundState(State):
    """The state when a round is ongoing."""

    def __init__(self, room):
        super(RoundState, self).__init__(room)
        self.drawing = Drawing(self.room)
        self.start_time = time.time()
        self.end_time = self.start_time + self.room.round_time
        self.phrase = self.room.phrase_chooser.next()
        self.guessers = set()
        self.rush_phase = False
        self.started_drawing = False
        self.total_hints = 2
        self.hints_remaining = self.total_hints
        self.current_hint = None
        self.can_skip = True

        self.artists = []
        discarded = []
        while len(self.room.users) + len(discarded) > 1 and len(self.room.users) and len(
                self.artists) < self.room.artist_count:
            user = self.room.users.pop(0)
            if not user.away:
                self.artists.append(user)
            else:
                discarded.append(user)
        self.room.users = self.room.users + discarded + self.artists

    def has_remaining_time(self):
        """Test whether the round's timer has not been reached."""
        return time.time() < self.end_time + self.room.time_fudge

    def has_drawing_artists(self):
        """Test whether there are still artists active.

        There might be an inactive artist if the artist disconnects.
        """
        return len(self.artists)

    def has_no_one_guessed(self):
        """Test whether no one has made a single correct guess."""
        return len(self.guessers) == 0

    def has_everyone_guessed(self):
        """Test whether everyone (excluding artists) has correctly guessed."""
        return not len(set(self.room.users).difference(self.guessers).difference(self.artists))

    def matches_phrase(self, text):
        """Test whether the given message matches the word that needs to be guessed."""
        return self.phrase.lower() in text.lower()

    def user_status(self, user):
        return {'name': user.name,
                'score': self.room.scores[user.name],
                'guessed': user in self.guessers}

    def send_state(self, user):
        data = {
            'state': 'draw' if user in self.artists else 'guess',
            'round': self.room.round,
            'artists': [u.name for u in self.artists],
            'elapsed_time': time.time() - self.start_time,
            'remaining_time': self.end_time - time.time(),
            'rush_phase': self.rush_phase,
            'guessers': [u.name for u in self.guessers],
            'hint': self.current_hint,
            'can_skip': self.can_skip,
            'hints_remaining': self.hints_remaining,
        }

        # The artists need to know the phrase too!
        # Though typically, a new joining player will likely not be an artist so
        # this code path will never be reached
        if user in self.artists:
            data['phrase'] = self.phrase

        user.send('state', data)

        self.drawing.send_drawn(user)

    def broadcast_scores(self, users):
        self.room.broadcast("scores", {'scores': [self.user_status(u) for u in users]})

    def add_guesser(self, user):
        # IF the user has already correctly guessed, do nothing
        if user in self.guessers:
            return

        # Calculate scores for the artists
        # First correct guess for artist is 10 pts for the artist
        # Otherwise 1 pt/guesser up to 5 points
        if not len(self.guessers):
            for artist in self.artists:
                self.room.scores[artist.name] += 10
        elif len(self.guessers) < 6:
            for artist in self.artists:
                self.room.scores[artist.name] += 1

        # The first player to guess gets 10 pts, followed by 9, 8, etc.
        # Until at minimum 5 points per every player
        self.room.scores[user.name] += max(5, 10 - len(self.guessers))

        # Keep track of the player that guessed
        self.guessers.add(user)

        # Play sound for everyone
        self.room.broadcast("guess_correct", {})

        # Tell the user that the guess was correct
        user.send("chat", {
            'type': 'correct',
            'msg': 'You guessed the word **{}**.'.format(self.phrase)
        })

        # Tell the artists of the correct guess
        for artist in self.artists:
            artist.send('chat', {
                'type': 'guessed-your-word',
                'msg': '**{}** guessed your word, *{}*.'.format(user.name, self.phrase)
            })

        # Tell everyone about the new scores
        self.broadcast_scores([user] + self.artists)

        # Tell the artists that skips and hints are now disabled
        if self.can_skip or self.hints_remaining:
            self.can_skip = False
            self.hints_remaining = 0

            for artist in self.artists:
                artist.send('state_update', {
                    'can_skip': self.can_skip,
                    'hints_remaining': self.hints_remaining
                })

        # Progress the round or game
        if self.has_everyone_guessed():
            self.advance()
        else:
            if not self.rush_phase:
                self.start_rush_phase()

    def advance(self):
        if self.has_no_one_guessed():
            self.room.messages.broadcast(
                "round-end",
                "Nobody guessed the word **{}**!".format(self.phrase))
        elif self.has_everyone_guessed():
            self.room.messages.broadcast(
                "round-end",
                "Everyone guessed the word **{}**!".format(self.phrase))
        elif len(self.guessers) == 1:
            self.room.messages.broadcast(
                "round-end",
                "**{}** guessed the word **{}**!".format(next(iter(self.guessers)).name, self.phrase))
        else:
            self.room.messages.broadcast(
                "round-end",
                "**{}** guessed the word **{}**!".format(", ".join([u.name for u in self.guessers]), self.phrase))

        self.next_state()

    def next_state(self):
        next_round = self.room.round + 1
        if next_round <= self.room.round_limit:
            self.room.round = next_round
            self.room.transition(RoundState(self.room))
            # TODO: Jump directly to wait state if there are no players?
        else:
            self.room.transition(ScoreState(self.room))

    def start_rush_phase(self):
        self.rush_phase = True
        now = time.time()
        self.end_time = now + self.room.rush_phase_time
        self.start_time = now

        self.room.broadcast("state_update", {
            'rush_phase': True,
            'elapsed_time': 0,
            'remaining_time': self.end_time - now,
        })

    def draw(self, data, user):
        self.started_drawing = True
        if user in self.artists:
            self.drawing.draw(data, user)

    def part(self, user):
        if user in self.artists:
            self.artists.remove(user)

    def skip(self, user):
        if user in self.artists and self.can_skip:
            self.room.messages.broadcast("round-end", "Round skipped by artist!")
            self.next_state()
            # TODO: don't have all current artists skip if one skips

    def hint(self, user):
        if user in self.artists and self.hints_remaining > 0:
            self.current_hint = create_hint(self.phrase, self.total_hints - self.hints_remaining + 1)
            self.hints_remaining -= 1

            # Tell everyone
            self.room.broadcast("state_update", {'hint': self.current_hint})
            for artist in self.artists:
                artist.send('state_update', {'hints_remaining': self.hints_remaining})

            # Reduce score for artists
            for artist in self.artists:
                self.room.scores[artist.name] -= 2
            self.broadcast_scores(self.artists)

    def say(self, user, message):
        if user in self.artists:
            return False  # Can't chat when drawing!

        guess = message.strip()
        prefix_match_length = len(os.path.commonprefix([self.phrase.lower(), guess.lower()]))

        if self.matches_phrase(guess):
            # Don't let people guess after the time has passed
            if time.time() > self.end_time + self.room.time_fudge:
                return False
            self.add_guesser(user)
            return True

        elif prefix_match_length >= 5 and prefix_match_length >= 0.3 * len(self.phrase):
            user.send("chat", {'type': 'close-guess', 'msg': '**{}** is close!'.format(guess)})
            for artist in self.artists:
                artist.send('chat', {
                    'name': user.name,
                    'msg': message
                })
            return True

    def think(self):
        now = time.time()

        if not self.room.has_enough_players():
            self.room.reset()
            self.room.transition(WaitForPlayersState(self.room))
        elif not self.has_drawing_artists():
            self.advance()
        elif not self.has_remaining_time():
            self.advance()
        elif self.has_everyone_guessed():
            self.advance()
        elif not self.started_drawing and now - self.start_time > self.room.draw_inactivity_time:
            for artist in self.artists:
                artist.away = True
            self.advance()


class ScoreState(State):
    def __init__(self, room):
        super(ScoreState, self).__init__(room)
        self.end_time = time.time() + self.room.score_time
        self.scores = self.room.scores
        self.room.reset()

    def send_state(self, user):
        scores = sorted([{'name': name, 'score': score} for name, score in list(self.scores.items())],
                        key=lambda x: -x['score'])
        user.send('state', {
            'state': 'score',
            'scores': scores,
        })

    def think(self):
        if time.time() > self.end_time:
            self.room.broadcast("scores_reset", {})
            self.room.transition(RoundState(self.room))


class Room(object):
    def __init__(self,
                 name,
                 word_list,
                 round_limit=20,
                 round_time=150,
                 rush_phase_time=20,
                 score_time=10,
                 artist_count=1,
                 min_player_count=2,
                 time_fudge=0,
                 draw_inactivity_time=30):
        assert min_player_count > 1, 'min_player_count > 1 otherwise bad things happen during artist selection'
        self.name = name
        self.round = 1
        self.round_limit = round_limit
        self.round_time = round_time
        self.rush_phase_time = rush_phase_time
        self.score_time = score_time
        self.artist_count = artist_count
        self.min_player_count = min_player_count
        self.time_fudge = time_fudge
        self.draw_inactivity_time = draw_inactivity_time
        self.messages = MessageLog(self)
        self.users = []
        self.scores = collections.defaultdict(lambda: 0)
        self.state = WaitForPlayersState(self)
        self.phrase_chooser = PhraseChooser(word_list)

    def has_enough_players(self):
        return self.count_active_users() >= 1 and len(self.users) >= self.min_player_count

    def count_active_users(self):
        active_users = 0
        for user in self.users:
            if not user.away:
                active_users += 1
        return active_users

    def reset(self):
        random.shuffle(self.users)
        self.scores = collections.defaultdict(lambda: 0)
        self.round = 1

    def transition(self, new_state):
        self.state = new_state
        for user in self.users:
            self.state.send_state(user)

    def broadcast(self, event, data, except_for=None):
        for user in self.users:
            if user != except_for:
                user.send(event, data)

    def broadcast_user_status(self, target):
        self.broadcast("user_status", target.user_status())

    def join(self, user):
        if user not in self.users:
            log.debug("{} joined #{}".format(user.name, self.name))

            user.room = self

            # Tell everyone else about the user join
            for u in self.users:
                u.send('user_join', {'name': user.name, 'score': self.scores[user.name], 'away': user.away})

            self.users.append(user)
            self.state.join(user)

            # Tell the user the room information
            users = []
            for user in self.users:
                status = user.user_status()
                status.update(self.state.user_status(user))
                users.append(status)
            user.send('room', {
                'name': self.name,
                'users': users,
            })

            self.messages.send_backlog(user)
            self.state.send_state(user)

    def part(self, user):
        if user in self.users:
            log.debug("{} parted #{}".format(user.name, self.name))

            self.users.remove(user)
            self.state.part(user)
            for u in self.users:
                u.send('user_part', {'name': user.name})

    def say(self, user, message):
        if not self.state.say(user, message):
            self.messages.append("chat", message, name=user.name)

    def think(self):
        self.state.think()


with open('words.txt', 'rb') as f:
    word_list = [x.decode('utf-8').strip() for x in f.readlines()]
print("read word list")
users = UserList()
rooms = {
    'default': Room('default', word_list),
    'testing': Room('testing', word_list, round_time=30, score_time=2, min_player_count=2),
}


def think():
    while True:
        for name, room in list(rooms.items()):
            room.think()
        eventlet.sleep(0.5)


eventlet.spawn(think)


def logged_in(f):
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        try:
            user = users.get(request.sid)
            return f(*args, user=user, **kwargs)
        except KeyError:
            return

    return wrapper


def in_room(f):
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        user = kwargs['user']
        if not user.room:
            return
        return f(*args, **kwargs)

    return wrapper


@app.after_request
def apply_caching(response):
    response.headers['Server'] = 'SKetch'
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["X-Content-Type-Options"] = "nosniff"
    for key in ('X-WebKit-CSP', 'X-Content-Security-Policy', 'Content-Security-Policy'):
        response.headers[key] = "default-src *; style-src * 'unsafe-inline'; media-src * 'unsafe-inline';"
    return response


@socketio.on_error()
def error_handler(e):
    traceback.print_exc()


@socketio.on('login')
def login(data):
    username = data['username']
    if VALID_NAME_PATTERN.match(username):
        try:
            users.login(request.sid, username)
            log.debug("{} has logged in (sid: {})".format(username, request.sid))
        except NameInUseError as e:
            emit('login_error', {'message': 'That name is in use.'})
            disconnect()
    else:
        emit('login_error', {'message': 'You need an alphanumeric name between 2 and 20 characters long.'})
        disconnect()


@socketio.on('connect')
def connect():
    log.debug("{} has connected".format(request.sid))


@socketio.on('disconnect')
def disconnect():
    users.quit(request.sid)
    try:
        user = users.get(request.sid)
        log.debug("{} has disconnected (sid: {})".format(user.name, request.sid))
    except KeyError:
        log.debug("(unnamed) has disconnected (sid: {})".format(request.sid))


@socketio.on('join')
@logged_in
def join(data, user=None):
    room_name = data['room']

    if room_name in rooms:  # Does the room exist yet?
        if user.room == rooms[room_name]:  # Is the user trying to join the channel s/he is in?
            pass
        else:
            if user.room:  # Leave the current room
                user.room.part(user)
            rooms[room_name].join(user)
    else:
        log.debug("{} tried to join non-existent room #{}".format(user.name, room_name))
        emit('alert', {'message': "The given room doesn't exist yet."})


@socketio.on('draw')
@logged_in
@in_room
def draw(data, user=None):
    user.room.state.draw(data, user)


@socketio.on('request_skip')
@logged_in
@in_room
def request_skip(data, user=None):
    user.room.state.skip(user)


@socketio.on('request_hint')
@logged_in
@in_room
def request_hint(data, user=None):
    user.room.state.hint(user)


@socketio.on('say')
@logged_in
@in_room
def say(data, user=None):
    if not len(data['msg'].strip()):
        return
    user.room.say(user, data['msg'])


@socketio.on('set_away')
@logged_in
def set_away(data, user=None):
    user.away = bool(data['away'])


@app.route('/bower_components/<path:filename>')
def bower_components(filename):
    return send_from_directory('bower_components', filename)


@app.route('/')
def index():
    return render_template('index.html', git_hash=version)


if __name__ == '__main__':
    logging.basicConfig(format='%(levelname)s [%(name)s] %(message)s', level=logging.INFO)
    logging.getLogger("sketch").setLevel(logging.DEBUG)
    logging.getLogger("geventwebsocket.handler").setLevel(logging.WARN)
    logging.info("Version: {}".format(version))
    socketio.run(app, host="0.0.0.0", port=8044)
