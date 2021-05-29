"use strict";

/**
 * Любое текстовое сообщение в ws событии или ответ на запрос к API.
 * Больше всего вариантов у метода `Buy`.
 * @readonly
 * @enum {String}
 */
const EMarketMessage = {
    Ok: "ok", // запрос выполнился нормально

    // API ping-pong
    TooEarlyToPong: "too early for pong",
    CheckTokenOrMobile: "token_check_or_mobile_authenticator",

    // Вывод предмета
    RequestErrorNoItems: "Ошибка создания заявки: У вас нет вещей для передачи",
    RequestErrorWrongBotId: "Ошибка создания заявки: Неправильный номер бота",
    RequestErrorItemListFail: "Ошибка создания заявки: Не удалось получить список предметов",
    RequestUnexpectedError: "Ошибка создания заявки: Exception", // Unexpected error. Normally we don't have to get it at all

    // Закупка предмета
    // наши траблы
    NeedMoney: "Недостаточно средств на счету",
    NeedToTake: "Вы не можете покупать, пока у вас есть доступные для вывода предметы.\nВыведите все предметы на странице \"Мои вещи\"",
    // что-то пошло не так
    BadOfferPrice: "Покупка данного предмета по такой цене невозможна. Обратитесь в техподдержку",
    RequestErrorNoList: "Ошибка создания заявки: Не удалось получить список предметов",
    // попробуйте снова
    BuyOfferExpired: "К сожалению, предложение устарело. Обновите страницу",
    SomebodyBuying: "Кто-то уже покупает этот предмет. Попробуйте ещё",
    ServerError7: "Ошибка сервера 7", // Unexpected error. Normally we don't have to get it at all
    // траблы маркета
    SteamOrBotProblems: "Возможны проблемы со стим или ботом, попробуйте позже.",
    BotIsBanned: "Бот забанен, скоро исправим.",
    // траблы юзера
    VacGameBan: "Error: reason VACBan or Game ban.",
    InvalidTradeLink: "Invalid trade link",
    SteamInventoryPrivate: "First you must open your inventory in your Steam profile settings.",
    OfflineTradeProblem: "Error verifying link. Our bot cannot take or transfer your items. Please check the function of offline trades on your account.",
    BadTokenInvClosed: "bad_token_inv_closed",
    CanceledTrades: "Передача предмета на этого пользователя не возможна, из-за не принятия большого кол-ва обменов.",
    BuyCanceledTrades: "Вы не можете покупать, так как не приняли слишком много предложений обмена",

    // WS events
    ItemReadyToTake: "Купленный предмет готов к получению, заберите его на странице \"Мои вещи\"",
    SupportAnswer: "Получен новый ответ от техподдержки",

    hash: function(message) {
        for(let name in EMarketMessage) {
            if(EMarketMessage.hasOwnProperty(name)) {
                if(EMarketMessage[name] === message) {
                    return name;
                }
            }
        }

        return null;
    },
};
Object.freeze(EMarketMessage);

module.exports = EMarketMessage;
