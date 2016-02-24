import io
import logging
import os.path
import random
import re
import subprocess

__all__ = ('get_git_revision_hash',
           'create_hint',
           'PhraseChooser',
           'DirectoryWordLists',
           'WordList')


def get_git_revision_hash():
    try:
        return subprocess.check_output(['git', 'describe', '--dirty', '--all', '--long']).decode('utf-8').strip()
    except Exception:
        logging.warning("Failed to get Git hash", exc_info=True)
        return "unknown"


def create_hint(phrase, reveal_length):
    words = phrase.split(" +")
    return ' '.join([w[:reveal_length] + '_' * (len(phrase) - reveal_length) for w in words])


class PhraseChooser(object):
    def __init__(self, word_list):
        self.word_list = word_list
        self.history = set()

    def next(self):
        return random.choice(self.word_list.words)


class WordList(object):
    def __init__(self, name, words):
        self.name = name
        self.words = words


class WordListDatabase(object):
    def list(self):
        pass

    def get(self, name):
        pass


class UnknownWordList(Exception):
    pass


class DirectoryWordLists(WordListDatabase):
    VALID_FILENAME_PATTERN = re.compile("^[A-Za-z0-9\\-_ ']{1,50}")

    def __init__(self, dir):
        self.dir = dir

    def get(self, name):
        if self.VALID_FILENAME_PATTERN.match(name):
            path = os.path.join(self.dir, name + ".txt")
            if os.path.exists(path):
                words = []
                with io.open(path, "r", encoding='utf-8') as f:
                    for line in f:
                        word = line.strip()
                        if word:
                            words.append(word)
                return WordList(name, words)
        raise UnknownWordList()
