import random
import threading
import traceback
import time

import re
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import collections
import functools
import os.path
from gevent import monkey, sleep
monkey.patch_all()

VALID_NAME_PATTERN = re.compile('^[A-Za-z0-9_]{2,20}$')

app = Flask(__name__)
app.debug = False
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode="gevent", allow_upgrades=True)


def create_hint(phrase, reveal_length):
    words = phrase.split(" +")
    return ' '.join(map(lambda w: w[:reveal_length] + '_' * (len(phrase) - reveal_length), words))


class PhraseChooser(object):
    def __init__(self, word_list):
        self.word_list = word_list
        self.history = set()

    def next(self):
        return random.choice(self.word_list)


class NameInUseError(Exception):
    pass


class User(object):
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
            self.room.broadcast_status(self)
            self.send('me', {'away': self._away})

    def send(self, event, data):
        socketio.emit(event, data, room=self.sid)


class UserList(object):
    def __init__(self):
        self.users = {}

    def login(self, sid, name):
        for _, user in self.users.iteritems():
            if user.name and user.name.lower() == name.lower():
                raise NameInUseError()
        user = User(sid, name)
        self.users[sid] = user
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
        return filter(lambda u: u.room == room, self.users.values())


class Drawing(object):
    def __init__(self, room):
        self.room = room
        self.log = []

    def draw(self, data):
        if data['action'] == 'clear':
            self.log = []
        self.log.append(data)
        self.room.broadcast('draw', data)

    def send_drawn(self, user):
        for data in self.log:
            user.send('draw', data)


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
    def __init__(self, room):
        super(RoundState, self).__init__(room)
        artist_count = min(len(self.room.users), self.room.artist_count)
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
        while len(self.room.users) > 1 and len(self.artists) < self.room.artist_count:
            user = self.room.users.pop(0)
            if not user.away:
                self.artists.append(user)
            else:
                discarded.append(user)
        self.room.users = self.room.users + discarded + self.artists

    def has_remaining_time(self):
        return time.time() < self.end_time + self.room.time_fudge

    def has_drawing_artists(self):
        return len(self.artists)

    def has_no_one_guessed(self):
        return len(self.guessers) == 0

    def has_everyone_guessed(self):
        return not len(set(self.room.users).difference(self.guessers).difference(self.artists))

    def matches_phrase(self, text):
        return self.phrase.lower() in text.lower()

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
        if user in self.artists:
            data['phrase'] = self.phrase
        user.send('state', data)
        self.drawing.send_drawn(user)

    def add_guesser(self, user):
        if not user in self.guessers:
            # first correct guess = 10 pts for artist
            if not len(self.guessers):
                for artist in self.artists:
                    self.room.scores[artist.name] += 10
            # up to 5 points with 1 pt/guesser for artist
            elif len(self.guessers) < 6:
                for artist in self.artists:
                    self.room.scores[artist.name] += 1

            # for each guesser: 10, 9, 8, etc. down to 5 min
            self.room.scores[user.name] += max(5, 10 - len(self.guessers))

            self.guessers.add(user)

            # tell the user that the guess was correct
            user.send("correct_guess", {})

            # print a chat message to the user too
            user.send("chat", {
                'type': 'correct',
                'msg': 'You guessed the word **{}**.'.format(self.phrase)
            })

            # tell everyone else about the new scores
            scores = [{'name': user.name, 'score': self.room.scores[user.name], 'guessed': True}]
            for artist in self.artists:
                scores.append({'name': artist.name, 'score': self.room.scores[artist.name]})
            self.room.broadcast("scores", {'scores': scores})

            # tell the artists that skips and hints are now disabled
            if self.can_skip or self.hints_remaining:
                self.can_skip = False
                self.hints_remaining = 0
                for artist in self.artists:
                    artist.send('round', {'can_skip': self.can_skip, 'hints_remaining': self.hints_remaining})

            if self.has_everyone_guessed():
                self.advance()
            else:
                if not self.rush_phase:
                    self.start_rush_phase()

    def advance(self):
        if self.has_no_one_guessed():
            self.room.messages.broadcast("round-end", "Nobody guessed the word **{}**!".format(self.phrase))
        elif self.has_everyone_guessed():
            self.room.messages.broadcast("round-end", "Everyone guessed the word **{}**!".format(self.phrase))
        elif len(self.guessers) == 1:
            self.room.messages.broadcast("round-end", "**{}** guessed the word **{}**!".format(
                next(iter(self.guessers)).name,
                self.phrase))
        else:
            self.room.messages.broadcast("round-end", "**{}** guessed the word **{}**!".format(
                ", ".join([u.name for u in self.guessers]),
                self.phrase))
        self.next_state()

    def next_state(self):
        next_round = self.room.round + 1
        if next_round <= self.room.round_limit:
            self.room.round = next_round
            self.room.transition(RoundState(self.room))
        else:
            self.room.transition(ScoreState(self.room))

    def start_rush_phase(self):
        self.rush_phase = True
        now = time.time()
        self.end_time = now + self.room.rush_phase_time
        self.start_time = now
        self.room.broadcast("rush_phase", {
            'elapsed_time': 0,
            'remaining_time': self.end_time - time.time(),
        })

    def draw(self, data, user):
        self.started_drawing = True
        if user in self.artists:
            self.drawing.draw(data)

    def part(self, user):
        if user in self.artists:
            self.artists.remove(user)
        # rest will be handled in think()

    def skip(self, user):
        if user in self.artists and self.can_skip:
            self.room.messages.broadcast("round-end", "Round skipped by artist!")
            self.next_state()
            # todo: don't have all current artists skip if one skips

    def hint(self, user):
        if user in self.artists and self.hints_remaining > 0:
            self.current_hint = create_hint(self.phrase, self.total_hints - self.hints_remaining + 1)
            self.hints_remaining -= 1

            # tell everyone
            self.room.broadcast("hint", {'hint': self.current_hint})
            for artist in self.artists:
                artist.send('round', {'hints_remaining': self.hints_remaining})

            # reduce score for artists
            scores = []
            for artist in self.artists:
                self.room.scores[artist.name] -= 2
                scores.append({'name': artist.name, 'score': self.room.scores[artist.name]})
            self.room.broadcast("scores", {'scores': scores})

    def say(self, user, message):
        if user in self.artists:
            return False # can't chat when drawing!

        guess = message.strip()
        prefix_match_length = len(os.path.commonprefix([self.phrase.lower(), guess.lower()]))

        if self.matches_phrase(guess):
            # don't let people guess after the time has passed
            if time.time() > self.end_time + self.room.time_fudge:
                return False
            self.add_guesser(user)
            return True

        elif prefix_match_length >= 5 and prefix_match_length >= 0.3 * len(self.phrase):
            user.send("chat", {'type': 'close-guess', 'msg': '**{}** is close!'.format(guess)})
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
        scores = sorted([{'name': name, 'score': score} for name, score in self.scores.iteritems()], key=lambda x: -x['score'])
        user.send('state', {
            'state': 'score',
            'scores': scores,
        })

    def think(self):
        if time.time() > self.end_time:
            self.room.broadcast("reset_scores", {})
            self.room.transition(RoundState(self.room))


class Room(object):
    def __init__(self, name, word_list):
        self.name = name
        self.round = 1
        self.round_limit = 20
        self.round_time = 150
        self.rush_phase_time = 20
        self.score_time = 10
        self.artist_count = 1
        self.min_player_count = 3
        self.time_fudge = 0
        self.draw_inactivity_time = 30
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

    def broadcast(self, event, data):
        for user in self.users:
            user.send(event, data)

    def broadcast_status(self, target):
        for user in self.users:
            user.send('status', {'name': target.name, 'away': target.away})

    def send_users(self, user):
        users = [{'name': u.name, 'score': self.scores[u.name], 'away': u.away} for u in self.users]
        user.send('users', {'users': users})

    def join(self, user):
        if user in self.users:
            return
        user.room = self
        for u in self.users: # doesn't include joining user
            u.send('join', {'name': user.name, 'score': self.scores[user.name], 'away': user.away})
        self.users.append(user)
        self.send_users(user)
        self.state.join(user)
        self.messages.send_backlog(user)
        self.state.send_state(user)
        user.send('join_room', {})

    def part(self, user):
        if user not in self.users:
            return
        self.users.remove(user)
        self.state.part(user)
        for u in self.users:
            u.send('part', {'name': user.name})

    def say(self, user, message):
        if not self.state.say(user, message):
            self.messages.append("chat", message, name=user.name)

    def think(self):
        self.state.think()


with open('words.txt', 'rb') as f:
    word_list = map(lambda x: x.strip(), f.readlines())
print "read word list"
users = UserList()
rooms = {
    'default': Room('default', word_list)
}


def think():
    while True:
        for name, room in rooms.iteritems():
            room.think()
        sleep(0.5)

threading.Thread(target=think).start()


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


@socketio.on_error()
def error_handler(e):
    traceback.print_exc()


@socketio.on('login')
def login(data):
    username = data['username']
    if VALID_NAME_PATTERN.match(username):
        try:
            users.login(request.sid, username)
            emit('login', {})
        except NameInUseError, e:
            emit('alert', {'message': 'That name is in use.', 'then': 'connect'})
    else:
        emit('alert', {'message': 'You need an alphanumeric name between 2 and 20 characters long.', 'then': 'connect'})


@socketio.on('disconnect')
def disconnect():
    users.quit(request.sid)


@socketio.on('join_room')
@logged_in
def join(data, user=None):
    room_name = data['room']

    if room_name in rooms:  # does the room exist yet?
        if user.room == rooms[room_name]:  # is the user trying to join the channel s/he is in?
            pass
        else:
            if user.room:  # leave the current room
                user.room.part(user)
            rooms[room_name].join(user)
    else:
        emit('alert', {'message': "The given room doesn't exist yet."})


@socketio.on('draw')
@logged_in
@in_room
def draw(data, user=None):
    user.room.state.draw(data, user)


@socketio.on('skip')
@logged_in
@in_room
def skip(data, user=None):
    user.room.state.skip(user)


@socketio.on('hint')
@logged_in
@in_room
def hint(data, user=None):
    user.room.state.hint(user)


@socketio.on('say')
@logged_in
@in_room
def say(data, user=None):
    if not len(data['msg'].strip()):
        return
    user.room.say(user, data['msg'])


@socketio.on('away')
@logged_in
def away(data, user=None):
    user.away = bool(data['away'])


@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    socketio.run(app, host="0.0.0.0", port=8044)
