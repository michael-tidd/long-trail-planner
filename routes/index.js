var express = require('express');
var router = express.Router();
var convert = require('xml-js');
var fs = require('fs');
const {parse} = require("json2csv/lib/json2csv");

const METERS_TO_FEET = 3.28084;
let HORZ_MPH = 3;
let VERT_FPH = 1800;
const ACTUAL_TOTAL_DISTANCE = 272;
const ACTUAL_TOTAL_ELEVATION = 77000;
const BASELINE_TIME = (ACTUAL_TOTAL_DISTANCE / HORZ_MPH) + (ACTUAL_TOTAL_ELEVATION / 4);
let REST_PERCENTAGE = .2;

// const PACK_BASE_WEIGHT = 8;
// const PACK_FOOD_WEIGHT = 18;
// const BODY_WEIGHT = 200;

let START_HOUR = 4;
let START_MIN = 12;

function getBaselineProgressPercentage(totalDistance, totalElevation){
  let progressTime = (totalDistance/HORZ_MPH) + ((totalElevation * METERS_TO_FEET)/4);
  let progressPercentage = progressTime / BASELINE_TIME;
  return progressPercentage;
}

function getPackWeight(totalDistance, totalElevation){

  let foodWeight = PACK_FOOD_WEIGHT * (1 - getBaselineProgressPercentage(totalDistance, totalElevation));
  return foodWeight + PACK_BASE_WEIGHT;
}

function getWeightFactor(totalDistance, totalElevation){
  let packWeight = getPackWeight(totalDistance, totalElevation);
}

/* GET home page. */
router.get('/', function(req, res, next) {
  // res.render('index', { title: 'Express' });

  if(req.query.hs !== undefined){
    HORZ_MPH = parseFloat(req.query.hs);
  }

  if(req.query.vs !== undefined){
    VERT_FPH = parseFloat(req.query.vs);
  }

  if(req.query.rp !== undefined){
    REST_PERCENTAGE = parseFloat(req.query.rp);
  }

  if(req.query.sh !== undefined){
    START_HOUR = parseFloat(req.query.sh);
  }

  if(req.query.sm !== undefined){
    START_MIN = parseFloat(req.query.sm);
  }

  // XML JS START
  let wProm = getData('./data/long-trail-waypoints.json');
  let tProm = getData('./data/long-trail-w-elevation.gpx');


  Promise.all([tProm,wProm]).then(result => {
    let xml = result[0];
    let wResult = JSON.parse(result[1]);
    let tResult = JSON.parse(convert.xml2json(xml, {compact: true, spaces: 4}));
    res.setHeader('Content-Type', 'application/json');
    let trackpoints = tResult.gpx.trk.trkseg.trkpt.map((trackpoint) => {
      return {lat: trackpoint._attributes.lat, lon: trackpoint._attributes.lon, ele: trackpoint.ele._text};
    });

    trackpoints = trackpoints.reverse();

    let waypoints = wResult.waypoints;

    // initialize trackpoints with indexes and measured distances
    let previousTrackpoint = null;
    let totalDistance = 0;
    trackpoints.forEach((trackpoint, index) => {
      trackpoint.index = index;
      if(previousTrackpoint != null){
        let distance = getHaversineDistance([previousTrackpoint.lon, previousTrackpoint.lat], [trackpoint.lon, trackpoint.lat], true)
        trackpoint.splitDistance = distance;
      } else {
        trackpoint.splitDistance = 0;
      }
      totalDistance += trackpoint.splitDistance;
      trackpoint.totalDistance = totalDistance;
      previousTrackpoint = trackpoint;
    });

    // initially pair waypoints to trackpoints
    waypoints.forEach(waypoint => {
      let minDistance = Number.MAX_VALUE;
      trackpoints.forEach(trackpoint => {
        let distance = getHaversineDistance([waypoint.lon, waypoint.lat], [trackpoint.lon, trackpoint.lat], true)
        if (distance < minDistance) {
          minDistance = distance;
          waypoint.closestTrackpointIndex = trackpoint.index;
        }
      });
    });

    // calculate the error between the measured distances and the known distances
    // also assign technical factor from waypoints to trackpoints
    let previousWaypoint = null;
    waypoints.forEach(waypoint => {
      let closestTrackpoint = trackpoints[waypoint.closestTrackpointIndex];

      if(previousWaypoint){
        let previousClosestTrackpoint = trackpoints[previousWaypoint.closestTrackpointIndex];
        waypoint.trackpointError = (waypoint.totalDst - previousWaypoint.totalDst)/(closestTrackpoint.totalDistance - previousClosestTrackpoint.totalDistance);
      } else {
        waypoint.trackpointError = waypoint.totalDst / closestTrackpoint.totalDistance;
      }

      if(waypoint.trackpointError < 1){
        waypoint.trackpointError = 1;
      }

      trackpoints.forEach((trackpoint, index) => {
        if(!trackpoint.error && index <= waypoint.closestTrackpointIndex) {
          trackpoint.error = waypoint.trackpointError;
          trackpoint.technicalFactor = waypoint.tecFactor;
        }
      });

      previousWaypoint = waypoint;
    });

    // recalculate trackpoint stats based on errors
    totalDistance = 0;
    trackpoints.forEach(trackpoint => {
      trackpoint.splitDistance = trackpoint.splitDistance * trackpoint.error;
      totalDistance += trackpoint.splitDistance;
      trackpoint.totalDistance = totalDistance;
    });

    let elevationGain = 0;
    previousTrackpoint = null;
    trackpoints.forEach(trackpoint => {
      // assign elevation data
      if (previousTrackpoint) {
        trackpoint.splitElevation = trackpoint.ele - previousTrackpoint.ele;
      } else {
        trackpoint.splitElevation = 0;
      }

      // calculate total elevation gain
      if( trackpoint.splitElevation > 0 ) {
        elevationGain += trackpoint.splitElevation;
      }

      previousTrackpoint = trackpoint;
    });

    // calculate times
    let totalTime = 0;
    let totalElevationGain = 0;
    let totalElevationDrop = 0;
    trackpoints.forEach(trackpoint => {
      let xTime = trackpoint.splitDistance / HORZ_MPH;
      let yTime = (trackpoint.splitElevation * METERS_TO_FEET) / VERT_FPH;
      trackpoint.splitTime = Math.max(xTime, yTime) * (1 + trackpoint.technicalFactor) * 60;
      totalTime += trackpoint.splitTime;
      trackpoint.totalTime = totalTime;
      if(trackpoint.splitElevation > 0){
        totalElevationGain += trackpoint.splitElevation;
      } else {
        totalElevationDrop += trackpoint.splitElevation;
      }

      trackpoint.totalElevationGain = totalElevationGain;
      trackpoint.totalElevationDrop = totalElevationDrop;


    });

    previousWaypoint = null;
    waypoints.forEach(waypoint => {
      let closestTrackpoint = trackpoints[waypoint.closestTrackpointIndex];
      waypoint.totalTime = closestTrackpoint.totalTime;
      waypoint.totalElevationGain = closestTrackpoint.totalElevationGain;
      waypoint.totalElevationDrop = closestTrackpoint.totalElevationDrop;
      waypoint.elapsedTime = waypoint.totalTime + waypoint.totalTime * REST_PERCENTAGE;


      if(previousWaypoint){
        waypoint.splitDistance = waypoint.totalDst - previousWaypoint.totalDst;
        waypoint.splitElevationGain = waypoint.totalElevationGain - previousWaypoint.totalElevationGain;
        waypoint.splitElevationDrop = waypoint.totalElevationDrop - previousWaypoint.totalElevationDrop;
        waypoint.splitTime = waypoint.totalTime - previousWaypoint.totalTime;
        waypoint.splitSpeed = waypoint.splitDistance / (waypoint.splitTime / 60);
      } else {
        waypoint.splitDistance = 0;
      }

      previousWaypoint = waypoint;
    });

    let maxSplitTime = 0;
    waypoints.forEach(waypoint => {
      // waypoint.baselineProgress = waypoint.closestTrackpoint.baselineProgress * 100;
      // waypoint.baselineTime = waypoint.closestTrackpoint.baselineTime / 24;
      // waypoint.baselineSpeed = waypoint.closestTrackpoint.baselineSpeed;
      // waypoint.speedPercentage = waypoint.baselineSpeed / HORZ_MPH;



      waypoint.splitTime = (waypoint.splitTime / 60); // convert to hours
      waypoint.splitTime = Math.round( waypoint.splitTime * 10) / 10; // round to a 10th

      waypoint.totalTime = (waypoint.totalTime / 60) / 24; // convert to days
      waypoint.totalTime = Math.round( waypoint.totalTime * 10) / 10; // round to a 10th

      let startDate = new Date(2019,7,22, START_HOUR, START_MIN);
      startDate.setMinutes(startDate.getMinutes() + (waypoint.elapsedTime));

      waypoint.elapsedTime = (waypoint.elapsedTime / 60) / 24; // convert to days

      waypoint.splitElevationGain = Math.round( waypoint.splitElevationGain * METERS_TO_FEET / 100 ) * 100; // round to nearest 100
      waypoint.splitElevationDrop = Math.round( waypoint.splitElevationDrop * METERS_TO_FEET / 100 ) * 100; // round to nearest 100

      waypoint.elapsedTime = Math.round( waypoint.elapsedTime * 10) / 10; // round to a 10th



      waypoint.date = formatDate(startDate);
      waypoint.unixTime = Math.round(startDate.getTime() / 1000)

      waypoint.splitDistance = Math.round( waypoint.splitDistance * 10) / 10; // round to a 10th
      waypoint.splitSpeed = Math.round( waypoint.splitSpeed * 10) / 10; // round to a 10th

      if(waypoint.splitTime > 0) maxSplitTime = Math.max(maxSplitTime, waypoint.splitTime);

      delete waypoint['closestTrackpointIndex'];
      delete waypoint['trackpointError'];
      // delete waypoint['lat'];
      // delete waypoint['lon'];
      delete waypoint['eleFt'];
      delete waypoint['tecFactor'];
      delete waypoint['totalTime'];
      delete waypoint['totalElevationGain'];
      delete waypoint['totalElevationDrop'];


    });



    if( req.query.fmt === "csv" ) {
      const csv = parse(waypoints);
      res.setHeader('Content-disposition', 'attachment; filename=long-trail.csv');
      res.set('Content-Type', 'text/csv');
      res.send(csv);
    } else {
      res.send(waypoints);
    }

    console.log(maxSplitTime);



    // let movingTime = (totalTime / 60) / 24;
    // res.send({elevationGain: eleGain * METERS_TO_FEET, movingTime: movingTime, totalTime: movingTime * (1+REST_PERCENTAGE)});

    // res.send(trackPoints);
  }).catch(error => console.error(error));

  // XML JS END

});

function getData(fileName) {
  return new Promise(function(resolve, reject){
    fs.readFile(fileName, (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });
}

function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0'+minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return date.getMonth()+1 + "/" + date.getDate() + "/" + date.getFullYear() + "  " + strTime;
}

function getHaversineDistance(coords1, coords2, isMiles) {
  function toRad(x) {
    return x * Math.PI / 180;
  }

  var lon1 = coords1[0];
  var lat1 = coords1[1];

  var lon2 = coords2[0];
  var lat2 = coords2[1];

  var R = 6371; // km

  var x1 = lat2 - lat1;
  var dLat = toRad(x1);
  var x2 = lon2 - lon1;
  var dLon = toRad(x2)
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var d = R * c;

  if(isMiles) d /= 1.60934;

  return d;
}

module.exports = router;
