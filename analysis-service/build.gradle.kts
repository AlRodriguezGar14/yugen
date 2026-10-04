plugins {
    kotlin("jvm") version "2.1.20"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.worksap.nlp:sudachi:0.7.5")
    implementation("com.google.code.gson:gson:2.13.1")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass.set("yugen.analysis.MainKt")
}

tasks.test {
    useJUnitPlatform()
}
