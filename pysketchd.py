import argparse
import functools
import io
import re
import traceback

import yaml
from flask import Flask, render_template, request, send_from_directory
from flask_socketio import SocketIO, emit, disconnect
from pysketch.game import *
from pysketch.util import *

VALID_NAME_PATTERN = re.compile('^[A-Za-z0-9_]{2,15}$')
SET_WORD_LIST_CMD_PATTERN = re.compile("^@@setwordlst +(.+)$", re.I)
APP_VERSION = get_git_revision_hash()


if __name__ == '__main__':
    logging.basicConfig(format='%(levelname)s [%(name)s] %(message)s', level=logging.INFO)
    logging.getLogger("sketch").setLevel(logging.DEBUG)
    logging.getLogger("geventwebsocket.handler").setLevel(logging.WARN)
    logging.getLogger("engineio").setLevel(logging.WARN)
    logging.getLogger("socketio").setLevel(logging.WARN)
    logging.info("Version: {}".format(APP_VERSION))

    parser = argparse.ArgumentParser(description='Process some integers.')
    parser.add_argument('config', help='the config file')
    args = parser.parse_args()

    with io.open(args.config, "r", encoding="utf-8") as f:
        config = yaml.load(f, Loader=yaml.SafeLoader)

    wordlist_db = DirectoryWordLists("words")
    users = UserList()
    rooms = RoomList()

    for name, room in config['rooms'].items():
        rooms.create(name, wordlist_db.get(room['word_list']), room.get("params", {}))

    app = Flask(__name__)
    app.debug = False
    app.config['SECRET_KEY'] = config['secret_key']

    socketio = SocketIO(app, heartbeat_interval=3, heartbeat_timeout=10, binary=False)

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
        response.headers['Server'] = 'SKetch ({})'.format(APP_VERSION)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @socketio.on_error()
    def error_handler(e):
        traceback.print_exc()

    @socketio.on('login')
    def login(data):
        username = data['username']
        version = data['version']

        if version != APP_VERSION:
            emit('login_error', {'message': 'You have an incorrect client version. Try refreshing your browser.'})
            disconnect()
            return

        if VALID_NAME_PATTERN.match(username):
            try:
                users.login(request.sid, username, socketio)
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

        try:
            target_room = rooms.get(room_name)
            if not user.room or user.room.name != room_name:
                if user.room:  # Leave the current room
                    user.room.part(user)
                target_room.join(user)
        except NoSuchRoomError:
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
        message = data['msg'].strip()
        if not len(message) or len(message) > 200:
            return
        m = SET_WORD_LIST_CMD_PATTERN.match(message)
        if m:
            word_list = wordlist_db.get(m.group(1))
            user.room.set_word_list(word_list)
        else:
            user.room.say(user, message)

    @socketio.on('set_away')
    @logged_in
    def set_away(data, user=None):
        user.away = bool(data['away'])

    @app.route('/bower_components/<path:filename>')
    def bower_components(filename):
        return send_from_directory('bower_components', filename)

    @app.route('/')
    def index():
        return render_template('index.html', git_hash=APP_VERSION)

    rooms.start()
    socketio.run(app, host=config.get("host", "0.0.0.0"), port=config.get("port", 5000))
