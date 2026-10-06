FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    USER=container \
    HOME=/home/container \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg lsb-release apt-transport-https \
        nginx unzip git xz-utils tzdata iproute2 procps \
    && curl -fsSLo /tmp/debsuryorg-archive-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb \
    && dpkg -i /tmp/debsuryorg-archive-keyring.deb \
    && echo "deb https://packages.sury.org/php/ bookworm main" > /etc/apt/sources.list.d/sury-php.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        php8.1-fpm php8.1-cli php8.1-mysql php8.1-pgsql php8.1-sqlite3 php8.1-gd php8.1-mbstring \
        php8.1-xml php8.1-curl php8.1-zip php8.1-intl php8.1-bcmath php8.1-soap php8.1-opcache \
        php8.2-fpm php8.2-cli php8.2-mysql php8.2-pgsql php8.2-sqlite3 php8.2-gd php8.2-mbstring \
        php8.2-xml php8.2-curl php8.2-zip php8.2-intl php8.2-bcmath php8.2-soap php8.2-opcache \
        php8.3-fpm php8.3-cli php8.3-mysql php8.3-pgsql php8.3-sqlite3 php8.3-gd php8.3-mbstring \
        php8.3-xml php8.3-curl php8.3-zip php8.3-intl php8.3-bcmath php8.3-soap php8.3-opcache \
        php8.4-fpm php8.4-cli php8.4-mysql php8.4-pgsql php8.4-sqlite3 php8.4-gd php8.4-mbstring \
        php8.4-xml php8.4-curl php8.4-zip php8.4-intl php8.4-bcmath php8.4-soap php8.4-opcache \
    && update-alternatives --install /usr/bin/php php /usr/bin/php8.3 83 \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs python3 make g++ \
    && npm install -g npm@11 \
    && rm -rf /var/lib/apt/lists/* /tmp/debsuryorg-archive-keyring.deb \
    && useradd -m -d /home/container -s /bin/bash container \
    && mkdir -p /home/container \
    && chmod 755 /home/container

COPY skel /opt/nestcp/skel
COPY entrypoint.sh /entrypoint.sh
COPY fetch.sh /opt/nestcp/fetch.sh
RUN sed -i 's/\r$//' /entrypoint.sh /opt/nestcp/fetch.sh /opt/nestcp/skel/start.sh \
        /opt/nestcp/skel/bin/yarus.sh /opt/nestcp/skel/bin/render-nginx.php \
        /opt/nestcp/skel/nginx/nginx.conf \
    && chmod 755 /entrypoint.sh /opt/nestcp/fetch.sh /opt/nestcp/skel/start.sh \
    && chmod -R a+rX /opt/nestcp /entrypoint.sh

WORKDIR /home/container

# Wings replaces process user (typically uid 988) and uses a read-only rootfs.
# Do not USER container here — Wings sets User at runtime.
CMD ["/bin/bash", "/entrypoint.sh"]
