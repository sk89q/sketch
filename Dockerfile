FROM python:3.8.2-slim-buster

WORKDIR /app

RUN apt-get update

RUN apt-get install -y \
    build-essential \
    python3-dev \
    libffi-dev \
    libssl-dev \
    curl \
    gnupg \
    git

RUN curl -sL https://deb.nodesource.com/setup_10.x | bash -
RUN apt-get update
RUN apt-get install -y nodejs
RUN pip3 install --upgrade pip pipenv
RUN apt-get update --fix-missing

COPY package.json .
RUN npm install --loglevel=error --verbose

COPY bower.json .
RUN npm run bower --allow-root install

COPY Pipfile .
RUN PIPENV_VENV_IN_PROJECT=1 pipenv install --skip-lock

COPY . .

RUN npm run gulp

RUN chmod +x bootstrap.sh

CMD ["sh", "bootstrap.sh"]
