// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const logger = require('./logger');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('demo.payment.transactions', {
  unit: '{transaction}',
});

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

  try {
    const baggage = propagation.getBaggage(context.active());
    const syntheticRequest = baggage?.getEntry('synthetic_request')?.value === 'true';

    if (syntheticRequest) {
      span.setAttribute('user_agent.synthetic.type', 'test');
    }

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
      'demo.payment.card_type': cardType,
      'demo.payment.card_valid': valid,
      'demo.user_context.loyalty_level': loyalty_level
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

    // Do not charge synthetic requests.
    if (syntheticRequest) {
      span.setAttribute('demo.payment.charged', false);
    } else {
      span.setAttribute('demo.payment.charged', true);
    }

    const enduserId = baggage?.getEntry('enduser.id')?.value;
    if (enduserId) {
      span.setAttribute('enduser.id', enduserId);
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
    transactionsCounter.add(1, { 'demo.payment.currency': currencyCode });

    return { transactionId };
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

    throw err;
  } finally {
    span.end();
  }
};
