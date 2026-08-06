use napi::{Error, Result};
use napi_derive::napi;

const MODEL_NAMES: [Model; 3] = [Model::SeasonalNaive, Model::WeightedMean, Model::CrostonSba];

#[derive(Clone, Copy)]
enum Model {
    SeasonalNaive,
    WeightedMean,
    CrostonSba,
}

impl Model {
    fn name(self) -> &'static str {
        match self {
            Self::SeasonalNaive => "seasonal_naive",
            Self::WeightedMean => "weighted_mean",
            Self::CrostonSba => "croston_sba",
        }
    }
}

#[napi(object)]
pub struct KernelForecast {
    pub selected_model: String,
    pub hourly_p50: f64,
    pub hourly_residual_p90: f64,
    pub recent_acceleration: f64,
    pub training_hours: u32,
    pub confidence: String,
    pub used_fallback: bool,
}

fn invalid(reason: impl Into<String>) -> Error {
    Error::from_reason(reason.into())
}

fn weighted_hourly_mean(series: &[f64]) -> f64 {
    if series.is_empty() {
        return 0.0;
    }
    let windows = [7 * 24, 14 * 24, 28 * 24];
    let weights = [0.55, 0.3, 0.15];
    let mut weighted = 0.0;
    let mut weight = 0.0;
    for (window, item_weight) in windows.into_iter().zip(weights) {
        let size = window.min(series.len());
        if size == 0 {
            continue;
        }
        let mean = series[series.len() - size..].iter().sum::<f64>() / size as f64;
        weighted += mean * item_weight;
        weight += item_weight;
    }
    if weight == 0.0 {
        0.0
    } else {
        weighted / weight
    }
}

fn croston_sba(series: &[f64], alpha: f64) -> f64 {
    let Some(first_index) = series.iter().position(|value| *value > 0.0) else {
        return 0.0;
    };
    let mut demand = series[first_index];
    let mut interval = (first_index + 1) as f64;
    let mut gap = 1.0;
    for value in &series[first_index + 1..] {
        if *value > 0.0 {
            demand += alpha * (*value - demand);
            interval += alpha * (gap - interval);
            gap = 1.0;
        } else {
            gap += 1.0;
        }
    }
    if interval <= 0.0 {
        0.0
    } else {
        (1.0 - alpha / 2.0) * (demand / interval)
    }
}

fn model_prediction(model: Model, training: &[f64], horizon_index: usize) -> f64 {
    if training.is_empty() {
        return 0.0;
    }
    match model {
        Model::WeightedMean => weighted_hourly_mean(training),
        Model::CrostonSba => croston_sba(training, 0.1),
        Model::SeasonalNaive => {
            let seasonal_index = training.len() as isize - 168 + (horizon_index % 168) as isize;
            if seasonal_index >= 0 {
                training[seasonal_index as usize]
            } else {
                weighted_hourly_mean(training)
            }
        }
    }
}

fn pinball(actual: f64, predicted: f64, probability: f64) -> f64 {
    let error = actual - predicted;
    if error >= 0.0 {
        probability * error
    } else {
        (probability - 1.0) * error
    }
}

fn select_model(series: &[f64]) -> (Model, Vec<f64>) {
    let validation_hours = (14 * 24).min(series.len() / 4);
    let start = 24.max(series.len().saturating_sub(validation_hours));
    let mut ranked = MODEL_NAMES.map(|model| {
        let mut residuals = Vec::with_capacity(series.len().saturating_sub(start));
        let mut loss = 0.0;
        let mut samples = 0usize;
        for index in start..series.len() {
            let predicted = model_prediction(model, &series[..index], 0);
            let actual = series[index];
            residuals.push((actual - predicted).max(0.0));
            loss += pinball(actual, predicted, 0.5);
            samples += 1;
        }
        let average = if samples == 0 {
            f64::INFINITY
        } else {
            loss / samples as f64
        };
        (model, residuals, average)
    });
    ranked.sort_by(|left, right| {
        left.2
            .total_cmp(&right.2)
            .then_with(|| left.0.name().cmp(right.0.name()))
    });
    let (model, residuals, _) = ranked.into_iter().next().expect("models are fixed");
    (model, residuals)
}

fn quantile(values: &[f64], probability: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((probability * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn recent_acceleration(series: &[f64], baseline: f64) -> f64 {
    if baseline <= 0.0 || series.len() < 6 {
        return 1.0;
    }
    let recent = series[series.len() - 6..].iter().sum::<f64>() / 6.0;
    if recent == 0.0 {
        1.0
    } else {
        (recent / baseline).clamp(0.75, 3.0)
    }
}

fn forecast_series(series: &[f64], fallback_rate: f64) -> KernelForecast {
    let sparse = series.len() < 7 * 24 || series.iter().sum::<f64>() < 5.0;
    if sparse {
        let hourly = if series.is_empty() {
            fallback_rate
        } else {
            weighted_hourly_mean(series).max(fallback_rate)
        };
        return KernelForecast {
            selected_model: "hierarchical_fallback".to_owned(),
            hourly_p50: hourly,
            hourly_residual_p90: hourly.max(0.25),
            recent_acceleration: 1.0,
            training_hours: series.len() as u32,
            confidence: if series.len() >= 72 { "medium" } else { "low" }.to_owned(),
            used_fallback: true,
        };
    }
    let (model, residuals) = select_model(series);
    let hourly = model_prediction(model, series, 0);
    KernelForecast {
        selected_model: model.name().to_owned(),
        hourly_p50: hourly,
        hourly_residual_p90: quantile(&residuals, 0.9),
        recent_acceleration: recent_acceleration(series, hourly.max(0.0001)),
        training_hours: series.len() as u32,
        confidence: if series.len() >= 28 * 24 {
            "high"
        } else {
            "medium"
        }
        .to_owned(),
        used_fallback: false,
    }
}

#[napi]
pub fn forecast_series_batch(
    series: &[f64],
    offsets: &[u32],
    fallback_rates: &[f64],
) -> Result<Vec<KernelForecast>> {
    if offsets.len() != fallback_rates.len() + 1 {
        return Err(invalid(
            "offsets must contain one boundary per item plus the final boundary",
        ));
    }
    if offsets.first().copied() != Some(0) {
        return Err(invalid("offsets must start at zero"));
    }
    if offsets
        .last()
        .copied()
        .map(usize::try_from)
        .transpose()
        .map_err(|_| invalid("offset is too large"))?
        != Some(series.len())
    {
        return Err(invalid(
            "the final offset must equal the flattened series length",
        ));
    }
    if offsets.windows(2).any(|window| window[0] > window[1]) {
        return Err(invalid("offsets must be monotonic"));
    }
    if series
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(invalid("series values must be finite and non-negative"));
    }
    if fallback_rates
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(invalid("fallback rates must be finite and non-negative"));
    }

    offsets
        .windows(2)
        .zip(fallback_rates)
        .map(|(window, fallback)| {
            let start = window[0] as usize;
            let end = window[1] as usize;
            Ok(forecast_series(&series[start..end], *fallback))
        })
        .collect()
}
