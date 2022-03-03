"use strict";

const EMarketMessage = require("./enums/system/EMarketMessage");
const EMarketEventStage = require("./enums/system/EMarketEventStage");
const EMarketEventType = require("./enums/system/EMarketEventType");

const EErrorType = require("./enums/EErrorType");
const EErrorSource = require("./enums/EErrorSource");
const MiddlewareError = require("./classes/MiddlewareError");

const MarketApi = require("../modules/MarketApi");
const FnExtensions = require("../modules/FnExtensions");

module.exports = MarketLayer;

/**
 * High lever layer to work with http://market.csgo.com
 *
 * @param {CMarketConfig} config
 * @param {console} [_logger]
 * @constructor
 */
function MarketLayer(config, _logger = console) {
    this._config = config;

    /** @interface {console} */
    this._log = _logger;

    this.started = false;
    this.pingEnabled = true;

    this.api = new MarketApi({
        gotOptions: {
            agent: {
                https: config.proxy,
            },
            retry: {
                retries: 3,
                statusCodes: [408, 413, 429, 500, 502, 503, 504, 520]
            }
        },
        apiKey: config.apiKey,
        htmlAnswerLogPath: config.errorLogPath,
    });

    this._wallet = null; // int, minor units
    this._buyDiscount = null; // ratio
}

MarketLayer.prototype.start = function() {
    if(this.started) {
        return;
    }
    this.started = true;

    this._log.trace("Starting market layer");

    FnExtensions.setWatcher(async() => {
        if(this.pingEnabled) {
            try {
                //await this.ping();
            } catch(e) {
                this._log.error("Major error on market ping-pong", e);
            }
        }
    }, this._config.pingInterval);

    if(this._config.applyDiscounts) {
        FnExtensions.setWatcher(async() => {
            this._buyDiscount = await this._getBuyDiscount();
        }, this._config.discountUpdateInterval);
    }
};

MarketLayer.prototype.buyItem = function(hashName, goodPrice, partnerId, tradeToken) {
    return this.getItemOffers(hashName, goodPrice).then((list) => {
        return this.buyCheapest(list, this.tradeData(partnerId, tradeToken));
    });
};

MarketLayer.prototype.buyCheapest = function(offers, tradeData) {
    let badItemPrice = false;

    let buyAttempt = () => {
        if(offers.length === 0) {
            throw MiddlewareError("All buy attempts failed", EErrorType.AttemptsFailed, EErrorSource.Market);
        }

        let balance = this._getAccountBalance();
        let instance = offers.shift();

        // fix for BuyOfferExpired. May also decrease total buying costs
        if(this._config.hackExpiredOffers && offers.length > 0) {
            let nextInstance = offers[0];

            instance.min_price = instance.price; // fall back
            instance.price = Math.max(instance.price, nextInstance.price - 1);
        }

        if(balance !== false && instance.price > balance) {
            throw MiddlewareError("Need to top up bots balance", EErrorType.NeedMoney, EErrorSource.Owner, {needMoney: instance.price});
        }

        return this._tryToBuy(instance, tradeData).then((data) => {
            if(data === null) {
                return buyAttempt();
            }

            return data;
        }).catch((err) => {
            // Комментарий поддержки: "Цена на предмет явно завышена, от цены в стиме, поэтому предмет разблокировке не подлежит"
            // Пример 95% этой ошибки: пытаемся купить за 30-50р предмет, который в стиме стоит 3-6р
            // В таком случае не имеет смысла постоянно пытаться покупать предмет по все большей цене
            if(err instanceof MiddlewareError && err.type === EErrorType.BadOfferPrice && !badItemPrice) {
                badItemPrice = true;

                return buyAttempt();
            }
            if(err.statusCode) {
                err.instance = instance;
            }

            throw err;
        });
    };

    return buyAttempt();
};

MarketLayer.prototype._tryToBuy = function(instance, tradeData) {
    let gotOptions = {
        retry: {
            retries: 1,
        },
    };

    let uprice = instance.price;

    return this.api.buyV2CreateFor(instance, uprice, tradeData, gotOptions).then((response) => {
	    if (!response.success) throw new Error('No "error" field, but success not true');

		return {
		    uiId: response.id,
		    classId: instance.classId,
		    instanceId: instance.instanceId,
		    price: this._applyDiscount(instance.min_price || uprice),
		    offerPrice: instance.min_price, // original price, provided by the market
		};
    }).catch(error=>{
		let response = error.response.body.error;

	    let message = EMarketMessage[EMarketMessage.hash(response.error)]; // workaround because we can receive either russian or english message

	    switch(message) {
		    case EMarketMessage.BadOfferPrice:
			    this._log.trace(`${response.result}; mhn: ${instance.hashName}; netid: ${instance.classId}_${instance.instanceId}; price: ${uprice}`);
			    throw MiddlewareError("Unable to buy item for current price", EErrorType.BadOfferPrice, EErrorSource.Market);

		    case EMarketMessage.BuyOfferExpired:
		    case EMarketMessage.SomebodyBuying:
		    case EMarketMessage.RequestErrorNoList:
		    case EMarketMessage.FailedToFindItem:
		    case EMarketMessage.SteamOrBotProblems:
		    case EMarketMessage.BotIsBanned:
		    case EMarketMessage.ServerError7:
			    this._log.trace(EMarketMessage.hash(message));
			    return null;

		    case EMarketMessage.NeedToTake:
			    throw MiddlewareError("Need to withdraw items", EErrorType.NeedToTake, EErrorSource.Owner);
		    case EMarketMessage.NeedMoney:
			    throw MiddlewareError("Need to top up bots balance", EErrorType.NeedMoney, EErrorSource.Owner, {needMoney: uprice});

		    case EMarketMessage.InvalidTradeLink:
			    throw MiddlewareError("Your trade link is invalid", EErrorType.InvalidToken, EErrorSource.User);
		    case EMarketMessage.SteamInventoryPrivate:
			    throw MiddlewareError("Your Steam inventory is closed", EErrorType.InventoryClosed, EErrorSource.User);
		    case EMarketMessage.OfflineTradeProblem:
			    throw MiddlewareError("Trade link failed, check your ability to trade", EErrorType.UnableOfflineTrade, EErrorSource.User);
		    case EMarketMessage.VacGameBan:
			    throw MiddlewareError("You have VAC or game ban", EErrorType.VacGameBan, EErrorSource.User);
		    case EMarketMessage.BuyCanceledTrades:
			    throw MiddlewareError("Send failed due to many declined trades", EErrorType.BotCanceledTrades, EErrorSource.User);
		    case EMarketMessage.CanceledTrades:
			    throw MiddlewareError("You have declined too many trades", EErrorType.CanceledTrades, EErrorSource.User);

		    default:
			    this._log.debug("Unknown buy res", response);

			    return null;
	    }
    });
};

MarketLayer.prototype.tradeData = function(partnerId, tradeToken) {
    if(partnerId && tradeToken) {
        return {
            partnerId: partnerId,
            tradeToken: tradeToken,
        };
    }

    return null;
};

/**
 * Returns asset variants to buy the item, sorted by their price
 * @param {String} mhn - Item hash name
 * @param {Number?} [maxPrice] - Max item price that we can accept
 * @return {Array<{instanceId: String, classId: String, price: Number, offers: Number}>}
 * @async
 */
MarketLayer.prototype.getItemOffers = async function(mhn, maxPrice) {
    let allowedPrice = maxPrice ? this._config.preparePrice(maxPrice) : Number.MAX_VALUE;

    function extractOffers(items) {
        return items.map((item) => {
            let ids = MarketApi.getItemIds(item);

            return {
                hashName: MarketApi.getItemHash(item),
                instanceId: ids.instanceId,
                classId: ids.classId,
                price: Number(item.price),
                offers: Number(item.offers || item.count),
            };
        });
    }

    function prepareOffers(items) {
        return items
            .filter((item) => item.price <= allowedPrice && item.offers > 0) // remove all expensive and empty offers
            .filter((item) => item.hashName === mhn) // remove all offers with the wrong items (yes, that happens)
            .sort((a, b) => a.price - b.price); // sort offers from cheapest to most expensive
    }

    let itemVariants = await this.api.searchV2ItemByHash(mhn);
    if(!itemVariants.success) {
        throw MiddlewareError("Can't get item variants on TM", EErrorType.RequestFailed, EErrorSource.Market);
    }
    if(!itemVariants.data || itemVariants.data.length === 0) {
        throw MiddlewareError("Got empty list of item variants on TM", EErrorType.NotFound, EErrorSource.Market);
    }

    let rawVariants = extractOffers(itemVariants.data);
    let preparedVariants = prepareOffers(rawVariants);

    if(preparedVariants.length === 0) {
        let message = "There are variants, but all of them are too expensive or invalid";
        let lowestPrice = Math.min.apply(null, rawVariants.map((item) => item.price));

        throw MiddlewareError(message, EErrorType.TooHighPrices, EErrorSource.Owner, {lowestPrice});
    }

    return preparedVariants;
};

/**
 * @param {Number} botWallet
 */
MarketLayer.prototype.setAccountBalance = function(botWallet) {
    this._wallet = Number(botWallet); // in cents
};

MarketLayer.prototype._getAccountBalance = function() {
    if(this._wallet === null) {
        return Number.MAX_VALUE;
    }

    return this._wallet;
};

MarketLayer.prototype._getBuyDiscount = async function() {
    return 0;

    let response;
    try {
        response = await this.api.accountGetDiscounts();
    } catch(e) {
        this._log.error("Failed to get discounts: ", e);

        return 0;
    }

    if(!response.success) {
        return 0;
    }

    let discounts = response.discounts;
    if(!discounts || !discounts.buy_discount) {
        return 0;
    }

    return discounts.buy_discount.replace('%', '') / 100;
};

MarketLayer.prototype._applyDiscount = function(price) {
    if(!this._config.applyDiscounts) {
        return price;
    }

    return Math.round(price * (1 - this._buyDiscount));
};

MarketLayer.prototype.setTradeToken = function(newToken) {
    return this.api.accountGetToken().then((data) => {
        if(data.success && data.token !== newToken) {
            return this.api.accountSetToken(newToken, {retry: {retries: 5}}).then(() => {
                if(!data.success) {
                    throw new Error(data.error);
                }

                this._log.log("Trade token updated on TM");
            });
        }
    });
};

MarketLayer.prototype.getTrades = function() {
    return this.api.accountGetTrades().then((trades) => {
        return trades.map((item) => {
            let ids = MarketApi.getItemIds(item);

            return {
                ui_id: Number(item.ui_id),
                ui_status: Number(item.ui_status),
                ui_price: Math.round(Number(item.ui_price) * 100),
                ui_bid: Number(item.ui_bid),
                classId: ids.classId,
                instanceId: ids.instanceId,
                market_hash_name: MarketApi.getItemHash(item),
                left: Number(item.left),
            };
        });
    });
};

MarketLayer.prototype.getTrade = function(uiId) {
    return this.getTrades().then((trades) => {
        return trades.find((trade) => trade.ui_id === Number(uiId));
    });
};

MarketLayer.prototype.getSteamTradeId = function(uiBid) {
    return this.takeItemsFromBot(uiBid).then((botTrade) => botTrade.trade_id);
};

MarketLayer.prototype.getBalance = async function() {
    const data = await this.api.accountV2GetMoney();
    if(!data || typeof data.money === 'undefined' || !data.success) {
        throw new Error('Failed to extract balance from response');
    }

    return data;

    return this.api.accountGetMoney().then((data) => {

        return Number(data.money);
    }).catch((e) => this._log.warn("Error occurred on getBalance: ", e));
};

MarketLayer.prototype.getWsAuth = function() {
    return this.api.accountV2GetWSAuth().then((auth) => {
        /**
         * @property {Boolean} auth.success
         * @property {String} auth.wsAuth
         */

        if(!auth.success) {
            throw auth;
        }

        return auth.wsAuth;
    }).catch((err) => {
        this._log.error(err);

        // retry
        return this.getWsAuth();
    });
};

MarketLayer.prototype.ping = function() {
    /**
     * @property {Boolean} data.success
     * @property {String} data.ping
     */
    return this.api.accountPingPong().then((data) => {
        if(data.success) {
            this._log.log("TM successfully answered: " + data.ping);

            return data.ping;
        } else {
            if(data.ping !== EMarketMessage.TooEarlyToPong) {
                this._log.warn("Failed to ping TM: " + data.ping);

                throw data.ping;
            }
        }
    }).catch((e) => {
        if(e.message !== EMarketMessage.CheckTokenOrMobile) {
            this._log.warn("Error occurred on pingPong request", e);

            return null;
        } else {
            this._log.warn("Error occurred on pingPong request", e.message);

            throw e;
        }
    });
};

MarketLayer.prototype.takeItemsFromBot = function(uiBid) {
    return this.api.tradeV2RequestTake(uiBid).then((answer) => {
        if(!answer.success) {
            throw answer;
        }

        return {
            trade_id: answer.trade, // steam trade id
            bot_id: answer.botid, // bot steam id
            secret: answer.secret, // secret code in trade message
            time: Date.now(),
        };
    });
};

/**
 * @param {Date} [operationDate] - date, when this items was bought
 * @param {Number} [timeMargin] - in milliseconds
 */
MarketLayer.prototype.getBoughtItems = function(operationDate, timeMargin = 60 * 1000) {
    // We have to align date if it is not passed in UTC+0
    if(this._config.handleTimezone) {
        let REQUIRED_TIMEZONE = 0; // UTC0
        let currentTimezone = operationDate.getTimezoneOffset();

        let offset = -(REQUIRED_TIMEZONE - currentTimezone);

        operationDate = new Date(operationDate.getTime() + offset * 60 * 1000);
    }

    let start, end;
    if(operationDate) {
        start = new Date();
        start.setTime(operationDate.getTime() - timeMargin);

        end = new Date();
        end.setTime(operationDate.getTime() + timeMargin);
    } else {
        start = new Date(0);
        end = new Date();
    }

    return this.api.accountV2GetHistory(start, end).then((history) => {
        if(history.success) {
            let buyEvents = history.data.filter((event) => {
                return event.event === EMarketEventType.BuyV2;
            });
            if(!buyEvents.length) {
                throw MiddlewareError("Buy events on " + operationDate + " not found", EErrorType.NotFound);
            }

            return buyEvents;
        } else {
            this._log.debug("Failed to fetch operation history", history, operationDate);

            throw MiddlewareError("Failed to get history", EErrorType.HistoryFailed);
        }
    });
};

/**
 * @param {Number} marketId - market item id
 * @param {Date} [operationDate] - date, when this item was bought
 */
MarketLayer.prototype.getItemState = async function(marketId, operationDate) {
    let initialMargin = 45 * 1000;
    let extendedMargin = 5 * 60 * 1000;
    let extractItem = (history) => history.find((event) => Number(event.item_id) === marketId);

    let getItem = async(margin) => {
        let history = await this.getBoughtItems(operationDate, margin);
        let buyEvent = extractItem(history);
        if(!buyEvent) {
            throw MiddlewareError("Event for marketItem#" + marketId + " not found", EErrorType.NotFound);
        }

        return buyEvent;
    };
    let makeRequests = async() => {
        try {
            return await getItem(initialMargin);
        } catch(e) {
            if(e.type === EErrorType.NotFound) {
                return await getItem(extendedMargin);
            } else {
                throw e;
            }
        }
    };

    let buyEvent;
    try {
        buyEvent = await makeRequests();
    } catch(e) {
        e.marketId = marketId;
        throw e;
    }

    let stage = Number(buyEvent.stage);
    if(!EMarketEventStage.has(stage)) {
        throw MiddlewareError("Unknown item operation stage", EErrorType.UnknownStage);
    }

    return stage;
};
