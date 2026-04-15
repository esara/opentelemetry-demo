// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics } = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const logger = require('./logger');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('app.payment.transactions');

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

// SC2 BUG: threshold was zeroed out during a config refactor (should be 0.8).
// Every transaction score exceeds 0.0, so every charge is rejected.
const FRAUD_RISK_THRESHOLD = 0.0;

/**
 * Inline fraud risk scoring against a static threshold.
 * BUG: FRAUD_RISK_THRESHOLD is 0.0 instead of 0.8 — rejects every transaction.
 */
async function runFraudCheck(transactionId) {
  const riskScore = Math.random() * 0.6;
  if (riskScore > FRAUD_RISK_THRESHOLD) {
    logger.error(
      { transactionId, riskScore: riskScore.toFixed(3), threshold: FRAUD_RISK_THRESHOLD },
      'SC2 fraud check rejected transaction: risk score exceeds threshold'
    );
    throw new Error(`transaction rejected by fraud check: score ${riskScore.toFixed(3)} exceeds threshold ${FRAUD_RISK_THRESHOLD}`);
  }
  return { riskScore };
}

/** Return random element from given array */
function random(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');

  // Benchmark SC2: flagd/OpenFeature evaluation disabled — keeps the injected
  // image focused on the fraud-check misconfiguration and avoids unrelated
  // EventStream noise from the demo's feature-flag plumbing.

  const {
    creditCardNumber: number,
    creditCardExpirationYear: year,
    creditCardExpirationMonth: month
  } = request.creditCard;
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const lastFourDigits = number.substr(-4);
  const transactionId = uuidv4();

  const card = cardValidator(number);
  const { card_type: cardType, valid } = card.getCardDetails();

  const loyalty_level = random(LOYALTY_LEVEL);

  span.setAttributes({
    'app.payment.card_type': cardType,
    'app.payment.card_valid': valid,
    'app.loyalty.level': loyalty_level
  });

  if (!valid) {
    throw new Error('Credit card info is invalid.');
  }

  if (!['visa', 'mastercard'].includes(cardType)) {
    throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
  }

  if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
    throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
  }

  // Check baggage for synthetic_request=true, and add charged attribute accordingly
  const baggage = propagation.getBaggage(context.active());
  if (baggage && baggage.getEntry('synthetic_request') && baggage.getEntry('synthetic_request').value === 'true') {
    span.setAttribute('app.payment.charged', false);
  } else {
    span.setAttribute('app.payment.charged', true);
  }

  try {
    await runFraudCheck(transactionId);
  } catch (err) {
    span.recordException(err);
    span.end();
    throw err;
  }

  const { units, nanos, currencyCode } = request.amount;
  logger.info({ transactionId, cardType, lastFourDigits, amount: { units, nanos, currencyCode }, loyalty_level }, 'Transaction complete.');
  transactionsCounter.add(1, { 'app.payment.currency': currencyCode });
  span.end();

  return { transactionId };
};
